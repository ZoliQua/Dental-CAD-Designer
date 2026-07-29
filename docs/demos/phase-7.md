# Phase 7 — Export & Manufacturing Handoff: demo script + acceptance evidence

Status: **the PLAN §Phase-7 acceptance is MET on the canonical
crown/inlay/onlay/bridge export fixtures** — all four PLAN criteria measured in
the FULLY COUPLED end-to-end loop (design chain → journaled export → server
independent re-validation on the exact bytes → release → download → re-import),
both at the server acceptance harness (Task 8, THE PHASE GATE) AND, this task,
through the real product export UI end to end. Read the headline caveat below
BEFORE treating "MET" as a finished, shippable-to-a-real-lab feature.

**Scope caveat, stated plainly (the Task 8 phase-gate verdict is the
authoritative scoping):** Phase 7 is **fixture-proven**, exactly like Phases 5
and 6 — the export/re-validation/traceability/archive loop is proven on
synthetic crown/inlay/onlay/bridge fixtures, not on a real patient scan. The
standing real-scan certifications (P3 retraction-cord crown, P5 cavity, P6
bridge) are **TRACKED-PENDING** and are NOT closed here (Open Items). A real-UI
gap this task's e2e surfaced — a fresh case's client QC stamped
`profileVersion: 'unversioned'` while the export resolved standard-zirconia
1.4.0, so the server honestly 409'd every real-UI export — was **fixed in the
Task 9 fix round** (a shared profile-version resolver); the live multi-material
**picker** remains the tracked carry-in (Open Item 3).

Branch `phase-7-export`. `KERNEL_VERSION` at phase end: **0.26.0** — **no bump
this phase** (Phase 6 also ended at 0.26.0). Export/handoff composes the EXISTING
kernel geometry: the io export layer (T2) lives entirely in
`packages/io/src/export/` reusing the unchanged writers, and every Phase 7 task
verified **zero diffs** under `packages/kernel|io(core)|cad-pipeline` — so no
version bump and no `docs/CHANGELOG-kernel.md` entry (the decision the plan asked
to be made + documented).

This document is the complete, honest ledger a human uses to judge Phase 7 —
every number below was measured by an actual test/report this session or a prior
Phase 7 task session (cited by file/task), nothing is asserted without a source,
and the Open Items section lists every known gap without softening.

## Headline: the four PLAN acceptance criteria, all met (measured in the coupled loop)

1. **An exported crown STL re-imports as watertight/manifold.** ✓ — proven for
   ALL FOUR restoration types on the ACTUAL downloaded bytes (re-parsed through
   the Node `@dqcad/io` parser + kernel intake, asserting `watertight` AND
   `manifoldEdges`, single component), and this task through the real
   released-file download link (crown).
2. **The QC traceability JSON is schema-validated.** ✓ — the server generates it
   from its OWN re-validation results, validates against the versioned
   `shared-types` JSON Schema at generation time, and it re-validates on read;
   `schemaVersion 2`, `documentKind: 'release'`, `outerEnvelopeCertified: true`,
   all four types.
3. **Tampered export bytes are REJECTED by re-validation (falsifiable).** ✓ —
   the full 4-variant tamper matrix is rejected with nothing released, identical
   rejection codes for all four types (16/16 rejections).
4. **Archive round-trip reproduces identical case state.** ✓ — export archive →
   import into a FRESH DB → case document deep-equal, `hashCaseJournal` match
   (journal replay-identical), scan + final-mesh + released bytes byte-identical,
   Export ledger row content-identical (only the `importedUnverified` provenance
   marker differs — the deliberate T6 trust boundary).

Plus the standing invariants: **export is a journaled operation** replayed
bit-identical; **QC gates block export** (acknowledge-with-warning journaled,
never bypassed); **dual validation stays dual** — the server re-validation
consumes the BYTES, never trusts the client result (CLAUDE.md invariant 6).

## Acceptance evidence table — the Task 8 phase-gate harness (`apps/server/src/export-acceptance.test.ts`, 20 tests)

The GENUINELY COUPLED loop per type (the P4 crown / P5 inlay+onlay / P6 bridge
finalMesh fixtures → the T2 export writers → the T3 journaled export op shape →
the T4 endpoint → server re-import + re-run every gate → release → GET download →
re-import the DOWNLOADED bytes). Every number is an actual test assertion
(console-logged `[ACCEPT …]` lines, reproduced independently by the T8 reviewer).
Kernel `0.26.0`, manifold-3d `3.5.1`.

| # | criterion | crown | inlay | onlay | bridge |
|---|---|---|---|---|---|
| **1** | re-import watertight / manifold (triangles) | ✓/✓ (5358) | ✓/✓ (43666) | ✓/✓ (74854) | ✓/✓ (4248) |
| **2** | traceability JSON schema-validated | v2, certified, valid | v2, certified, valid | v2, certified, valid | v2, certified, valid |
| **3** | tamper matrix rejected (nothing released) | 4/4 | 4/4 | 4/4 | 4/4 |
| **4** | archive round-trip identical (fresh DB) | identical | identical | identical | identical |

### Criterion 3 — the tamper matrix (identical rejection codes for all four types, 16/16)

| variant | status | rejection code |
|---|---|---|
| geometry byte-flip (breaks the weld) | 400 | `export-reimport-integrity` |
| outer-vertex move (welds cleanly, gate-invariant) | 409 | `export-outer-envelope-mismatch` |
| threshold tamper (loosened riding threshold) | 409 | `export-profile-threshold-mismatch` |
| truncation | 400 | `export-bytes-parse-failed` |

Criterion 4 additionally asserts per type: final-mesh bytes byte-identical,
released bytes downloadable byte-identical from the fresh target, and archive
export determinism (two exports bit-identical).

**Runtime:** the acceptance suite runs in **~53 s** (T8 report; ~74 s under the
reviewer's cold, loaded run) — one QC recompute per type at release: crown ~1 s,
inlay ~8 s, onlay ~38 s, bridge ~0.7 s; the tamper matrix rejects BEFORE the QC
recompute, so it is cheap even for the cavity fixtures. Kept in the default
`npm test` lane; no env-gated heavy duplication (fixtures reused, never rebuilt).

## The security-hardening story — the phase's defining work (stated honestly)

Phase 7's real substance is not "write STL bytes" (T2 composes the existing
writers); it is making the manufacturing handoff **defensible** — every closure
below is FALSIFIABLE (a demonstrated exploit that released before, refused now):

- **Server-resolved threshold authority (T4-F1 — the most important invariant
  defense).** The reviewer's exploit: a thin crown with a real **295 µm** wall
  (clinical minimum 500 µm) shipped with `qcContext.minWallThicknessMm = 0.05` +
  a matching client report → **released 200**, "passed", the loosened 0.05
  recorded in the "authoritative" ledger. Closed by server-side profile pinning
  (`export-profile.ts`): the profile is resolved + checksum-verified against the
  `@dqcad/clinical-profiles` registry, and every profile-derived threshold riding
  in `qcContext` is verified EQUAL to that authority → now **409
  `export-profile-threshold-mismatch`** (resolved 0.5), nothing released. The
  free tolerance knobs with no profile source are schema-FORBIDDEN entirely.
  ADR-017.
- **Outer-envelope certification — now MANDATORY + certified (T6 then T8).** A
  coordinated byte tamper that moves a welded vertex OUTWARD (identically across
  its ~8 soup occurrences, away from the die) welds cleanly, stays
  watertight/manifold, and leaves every gate value unchanged — it **released**
  (probed on the crown fixture: 8 vertices +0.4 mm → 200). T6 added a
  content-addressed final-mesh container (`DQFM`), persisted at save, and a
  step-10.5 assertion `hashMesh(reimport) ===
  hashMesh(narrow32(canon(storedFinalMesh)))` → **409
  `export-outer-envelope-mismatch`**. T8 made that persistence **MANDATORY** on
  every release path (absent → **409 `export-final-mesh-not-persisted`**, proven
  on a fresh empty final-mesh store where the pre-T8 case returned 200
  uncertified), which let `outerEnvelopeCertified` flip **false → true**
  (traceability `schemaVersion 1 → 2`). ADR-015.
- **Teeth-identity verification (T5-B1).** `identity.teeth` was the one
  client-supplied field flowing unverified into the release ledger + certified
  document — a wrong-site labeling defect (request teeth 16→26 while all
  hash/journal bookkeeping stayed consistent → **released 200** with tooth 26
  certified). Closed with a THREE-WAY exact-sequence check (request = saved
  restoration = journaled op) → **409 `restoration-teeth-mismatch` /
  `export-operation-teeth-mismatch`**, nothing released.
- **Verdict-authorized requests (T3, T3-F1).** `buildExportRequest` REQUIRES
  `exportGateVerdict(...).allowed` — the verdict authorizes, it no longer just
  harvests acks. A plain QC re-run that RESETS acknowledgments on the same mesh
  now flips the export record `done → stale` (and refuses the request), closing a
  de-authorized-export-could-still-ship hole.
- **Manifest self-hash + import trust boundary (T6).** The DQCA archive gained a
  `manifestSha256` self-hash over the manifest's own descriptive fields
  (descriptive-field tamper on `case.name`/`kernelVersion`/entry `kind` parsed
  cleanly before, rejected now). The archive is INTEGRITY, not AUTHENTICITY: an
  imported release row cannot be re-validated (the riding `qcContext` is not
  recoverable), so every imported release is stamped **`importedUnverified:
  true`** — a deliberate, explicit second ledger write-path, never silently
  trusted (ADR-016), surfaced to the user in the panel (T7).

## Reproducibility — record → replay → bit-identical (including the export op)

Export is a deterministic function of the finalMesh + params + kernel version:
two independent `exportStlBinary(finalMesh)` calls produce **bit-identical bytes
+ identical sha256**, per type; the RELEASED `bytesSha256` equals a fresh
serialization's hash and the DOWNLOADED bytes hash to the same value (the release
delivered the deterministic bytes); the server re-import is deterministic on
re-run; two archive exports of the same case are byte-identical (T8 Part C, #4).
The design-chain record→replay→bit-identical determinism is the existing
P4/P5/P6 journal discipline (all green this phase) extended to export by the T3
golden journal-replay fixture `sphere-r5-restoration-export` (two
`restoration-export` ops recorded with `outputHashes[0]` = bytes sha256,
recomputed fresh on every CI replay). No timestamps enter any hashed content
(ADR-018): the traceability document carries zero timestamps (`canonicalStringify`,
regex-asserted); `releasedAt` is a ledger record field / an explicitly-labeled
non-hashed HTML envelope line only.

## THIS TASK — the live product export UI, end to end (`e2e/phase7.spec.ts`)

The tables above prove the server/pipeline layer. This task adds the missing
layer: driving the REAL export & handoff product UI (`ui/ExportPanel.tsx`, built
T7) end to end, in a real Chromium browser, against an isolated server + client
bootstrap (below) — real file import, real margin + crown-design worker jobs
(incl. the manifold-3d WASM shell), real server routes (T4 re-validation, T5
traceability, T6 archive), real save/reload, real download links.

### Coverage (6 tests, one `describe.serial` block, all green — two consecutive clean runs, 6/6, ~36 s each)

The spec re-derives `e2e/phase4.spec.ts`'s small, clean, BUILDABLE shoulder-
margin crown (the real arch-case-01 tooth-11 is unbuildable end to end — see
phase4's top doc), designs it to a finalMesh through the real coupled workflow,
then carries it into the export panel:

| step | result |
|---|---|
| import a synthetic shoulder-prep die (real STL input), design a crown (margin → inner → anatomy → morph → shell → QC) to a finalMesh — a FRESH case, no material-profile setup needed (the fix-round shared resolver stamps zirconia 1.4.0) | PASS; QC genuinely FAILS minWallThickness + seating at the razor-thin cervical seam (the phase4 finding), unacknowledged |
| **HONEST-FAILURE + ADR-014 PROOF** — the export panel BLOCKS export while a failing gate is unacknowledged: `export-gate-block` (`role="alert"`) shown, the export button DISABLED, nothing POSTed, nothing released; the `export-disclosure` synthetic-data banner rides the panel | PASS |
| acknowledge the failing gates through the REAL journaled crown-QC acknowledge flow → the panel's recap flips to all-pass, the gate-block clears, the export button ENABLES | PASS |
| export (STL) → the client journaled export → `POST /export` (the SERVER independently re-imports the exact bytes, re-runs every gate, certifies the outer envelope, generates the traceability doc) → **released** | PASS; the released card renders the real download link + BOTH traceability links (HTML `?lang=` + JSON), all with server hrefs, + the released hash |
| **ACCEPTANCE CRITERION 1 (live)** — the released STL is re-downloaded from the real link and re-imported through the real `@dqcad/io` parser + kernel intake: watertight ✓, manifold ✓, 1 component; the traceability JSON is fetched: `documentKind: 'release'`, `schemaVersion: 2`, `outerEnvelopeCertified: true` | PASS |
| **ARCHIVE round-trip + invariant 5 + T6 trust boundary** — export the `.dqca` (magic asserted), re-import it over the same case id → **409 conflict surfaced as a confirm prompt** (no silent overwrite); confirm overwrite → imported; the imported case carried the released Export row → the `importedUnverified` provenance line renders | PASS |

**What this e2e does and does NOT cover (say exactly what you covered):** it
covers the local gate-BLOCK honest-failure surface (buttonless, no
retry-to-green) live, the release + download + both traceability links live,
acceptance criterion 1 (re-import) live from the real released link, criterion 2
(traceability schema shape) live, and the archive export/import round-trip with
the invariant-5 overwrite confirm + the `importedUnverified` provenance live. It
does NOT re-force the **server-mismatch diagnostic** surface (the per-field diff
+ diagnostic id, no retry button): a genuine client/server QC delta is not
reachable on the happy path without byte tampering, so that surface is proven by
`ExportPanel.dom.test.tsx`'s browser-lane tests (stubbed fetch) — though this
session DID measure a real server mismatch live (next paragraph), it is
engineered out of the deterministic happy path.

### A real gap this task surfaced — then FIXED at the root (the `profileVersion` export-mismatch — the T7-N3 concern)

Driving the export through the REAL UI (not the T8 harness) revealed a genuine
dual-validation catch the fixture harness had masked. A freshly created case has
EMPTY `settings` (`{ materialProfileId: '', profileVersion: '' }`), so the client
design engines USED TO stamp `QcReport.profileVersion: 'unversioned'`
(`document.settings.profileVersion || 'unversioned'`) while the export request/
server resolve the profile to standard-zirconia **1.4.0** — so the server's
independent re-validation HONESTLY refused **409 `export-qc-mismatch`** on the
`profileVersion` field (diagnostic bundle persisted, nothing released) for EVERY
real-UI export, even though the thresholds were already zirconia 1.4.0's. (The T8
harness never hit this because it constructs client reports whose
`profileVersion` already equals the registry profile's — the T4 fixture-identity
note.) **The Task 9 fix round closed it at the root:** a single shared resolver
(`engine/materialProfile.ts` — `resolveMaterialProfile` / `resolveProfileVersion`,
extracted from `exportFlow.ts` as a leaf module so it can't cycle with the design
engines) is now called by BOTH paths — the QC stamp in all three engines
(`crownDesign`/`cavityDesign`/`bridgeDesign`) AND the export request + traceability
preview — so an empty-settings case stamps `1.4.0` consistently and the server
agrees. The e2e proves a FRESH case releases with no profile setup at all. This
confirms the honest T7-N3 verdict: `restorationType` server-derivation is already
correct (inlay AND onlay release in T8), and the residual `profileVersion` field
is now consistent by construction. The live **multi-material picker** (choosing
e.max etc. from the UI, which would set `settings.materialProfileId`) remains the
tracked carry-in (Open Item 3).

### Isolated e2e infrastructure (the P4-T13 precedent — NON-NEGOTIABLE)

**NEVER edited** the committed `apps/server/src/index.ts`,
`apps/client/vite.config.ts`, or `playwright.config.ts` — all watched by / used
by a developer's own live dev process (the P4-T13 incident: an edit to
`index.ts` once caused a live `tsx watch` to restart onto a temp port against the
REAL dev database). Instead, all UNTRACKED and removed after the session:

- A standalone server-bootstrap script imported `buildApp`
  (`apps/server/src/app.ts` — `meshDataDir`/`toothLibraryDataDir`/
  `exportsDataDir`/`finalMeshDataDir`/`prisma` are constructor options for
  exactly this reason) and listened on **`:4298`**, against an ISOLATED temp
  SQLite DB (`prisma migrate deploy` against a throwaway `mkdtemp` file) and
  isolated temp mesh / tooth-library / exports / final-mesh data dirs.
- A SEPARATE untracked Vite config served the client on **`:5298`**, proxying
  `/api` to the isolated `:4298`.
- A SEPARATE untracked Playwright config (`baseURL :5298`, NO `webServer` block)
  ran the spec against the manually-started isolated stack.
- The developer's live `:5198` and the committed `:5173`/`:4100` were never
  touched (confirmed: no process listened on any of them at session start).

## KERNEL_VERSION across the phase (0.26.0 → 0.26.0, no bump)

Phase 6 ended at `0.26.0` (`docs/demos/phase-6.md`). Phase 7 is an export/
handoff/server/UI phase: **no task touched `packages/kernel|io(core)|
cad-pipeline` geometry** — every T1–T9 report verified zero diffs under those
trees and byte-identical geometry/qc goldens. The io export layer (T2) is new
code under `packages/io/src/export/` that COMPOSES the unchanged writers, so it
did not bump the kernel version either (the decision, documented in T2). The ONLY
sanctioned golden move in the whole phase was the T8 traceability
`schemaVersion 1 → 2` re-pin (two traceability pins), honestly attributed as
documented schema evolution, not numerical drift — every geometry / qc / T2
export pin is byte-identical, and `test:golden` reports **257 passed, no pin
moved**.

## Open items (honest, not resolved by this task — tracked for whoever picks this up next)

1. **Fixture-proven, no real patient scan — TRACKED-PENDING.** Phase 7's export/
   re-validation/traceability/archive loop is proven on synthetic
   crown/inlay/onlay/bridge fixtures, exactly like Phases 5 and 6. Not a code
   fix; needs the standing real cases (item 2).
2. **The standing real-scan certifications carry forward, NOT closed here:** P3
   retraction-cord crown margin accuracy (needs a retraction-cord scan); P4 real
   tooth-11 crown; P5 real inlay/onlay scan (+ the onlay seating fillet-removal
   geometry item, ADR-010); P6 real multi-abutment bridge scan. None block Phase
   7 acceptance (fixture-proven, caveat stated).
3. **The `profileVersion` real-UI 409 — RESOLVED for the default single-material
   (zirconia) case; the live multi-material PICKER remains the tracked carry-in.**
   The Task 9 fix round unified the QC stamp and the export path on one shared
   resolver (`engine/materialProfile.ts`), so a fresh empty-settings case stamps
   standard-zirconia 1.4.0 consistently and a real-UI export now RELEASES (proven
   by the e2e from a plain new case, no seed). What remains: a material-selection
   UI that lets a user pick e.max (or another registry profile) by setting
   `settings.materialProfileId` — the same "live material picker tracked, not
   this phase" carry-in as T3/T4/T7. Until it lands every case defaults to
   standard-zirconia (the honest identity of the thresholds the design engines
   already use).
4. **qcContext serialized on the UI thread (T7 follow-up).** `releaseToServer`
   serializes the riding design surfaces (`Array.from` + `JSON.stringify`) on the
   UI thread; for a large marching-cubes fit/inner/outer surface this can exceed
   the 50 ms budget — the same class the T3 review moved to a worker (the base64
   encode). A worker-side qcContext serialization is the honest follow-up;
   flagged, not done.
5. **T7-N3 `restorationType` server-confirm — RESOLVED in T8, verified here.** The
   server derives `restorationType` from the VERIFIED request (not the context),
   and T8's harness proves inlay AND onlay both release through the correct gate
   branch (the onlay carrying its acknowledged seating gate journal-verified). No
   residual on restorationType; the residual is `profileVersion` (item 3).
6. **Archive re-validation-on-import is DEFERRED, provenance-marked (T6 F-B1).**
   Re-running the export QC on import needs the riding `qcContext` (design-time
   surfaces the release ledger deliberately never persists), so it is not
   tractable; every imported release is stamped `importedUnverified: true`
   instead (INTEGRITY, not AUTHENTICITY — ADR-016). A future hardening could
   re-run only the geometry-only outer-envelope check on imports whose finalMesh
   container is present; the QC-gate re-run stays blocked on the un-persisted
   qcContext.
7. **Action-scoped provenance display (T7-N4).** The panel's `importedUnverified`
   line is derived from the import RESULT and clears on dismiss/reload; there is
   no per-release badge (no "list a case's exports" GET route). Not a safety hole
   (imported releases are never rendered in the release store, so an unverified
   release is never mislabeled server-verified), but a re-openable per-release
   provenance badge would be an improvement.
8. **A malicious client could skip the finalMesh upload** to reach a legacy
   absent-provenance path — but T8 made persistence MANDATORY at the release gate
   (`export-final-mesh-not-persisted`), so a normal release cannot; the only
   genuinely-unrecoverable case is a finalMesh NEVER saved with a live session
   (post-reload, the same reason the client's `finalMeshUnavailable` refusal
   exists). Disclosed, not a release path.
9. **`selfIntersection` remains a manifold-construction PROXY** (carried from
   Phase 4/5/6, out of scope per the phase plan): PASS means "manifold-3d accepts
   the solid as a finite/consistent 2-manifold", not "provably free of
   triangle-triangle self-intersection". A FAIL is always genuine.
10. **STL facet normals are not re-verified against winding on read (T4-N1).** A
    mill trusting STORED normals under a consistent adversary could see tampered
    normal fields; a "stored normal agrees with winding" check is a cheap
    documented follow-up (the re-validation certifies geometry from winding; T2
    certifies winding-outward bytes).
11. **The recurring qc-pin churn on every kernel bump** (flagged Phase 5/6) did
    NOT recur this phase — no kernel bump — but the structural cause
    (`hashQcReport` embeds `kernelVersion`) remains for the next bumping phase.
12. **The `@dqcad/kernel-workers` package is a server dependency now** (promoted
    from devDependency in T4 so the server imports the shared
    `@dqcad/kernel-workers/journal-hash` — the ONE journal-hash implementation
    both sides bind to). Documented, not a defect.

## Full local acceptance chain (this task, this session)

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit **0** (all workspaces) |
| `npm run lint` | exit **0** (only the 2 pre-existing warnings in the untouched `test/golden/onlay-acceptance.test.ts`) |
| `npm test` | exit **0** — **NUMBERS pinned in `.superpowers/sdd/p7-task-9-report.md` (fix-round)** — the 3 qc golden pins byte-identical |
| `npm run test:golden` | exit **0** — **257 passed / 9 skipped**, no pin moved (`git status test-fixtures/` empty; the 3 qc pins byte-identical — the fix-round pin guard) |
| `npx playwright test --config <untracked isolated> e2e/phase7.spec.ts` (×2 consecutive) | exit **0** both times — **6/6 passed, ~37 s**, against the isolated bootstrap above (a FRESH case, no profile seed) |

Goldens unchanged this phase — no kernel/pipeline op touched (the fix-round's
shared profile-version resolver only touches the client QC-stamp, which the
golden qc fixtures do NOT flow through — the 3 qc pins are byte-identical; plus
the e2e, docs, and ADRs), no `KERNEL_VERSION` bump, no `test-fixtures/` diff.
Coverage note closed: `export-acceptance-lib.ts` (T8) measures **100 % stmt
/ 91.3 % branch / 100 % func / 100 % line** (the sub-100 branch is the two
defensive `moveApexOutward` throw arms the T8 reviewer flagged as unreachable in
the happy path — ≥ 90 % on both stmt and branch).

## ADRs (this phase)

- **`docs/adr/015-final-mesh-provenance-outer-envelope.md`** (T6) — the DQFM
  final-mesh container + the outer-envelope certification assertion, and why the
  `outerEnvelopeCertified` flip was DEFERRED to T8 (made mandatory then).
- **`docs/adr/016-case-archive-container.md`** (T6) — the DQCA archive format
  (documented deterministic concatenation, not ZIP), the manifest self-hash, and
  the INTEGRITY-not-AUTHENTICITY trust boundary (`importedUnverified`).
- **`docs/adr/017-server-authoritative-export-revalidation.md`** (this task,
  T4/T4-F1) — the bytes-based dual-validation design + the server-resolved
  profile/threshold authority (the phase's most important invariant defense),
  the three-class request boundary, and release/download semantics.
- **`docs/adr/018-export-transport-journal-hash-and-traceability-determinism.md`**
  (this task, T3/T5) — the base64-in-JSON transport, the `caseJournalHash`
  definition (id/timestamp excluded for replay-invariance), and the
  traceability zero-timestamp determinism policy.

## Demo script — driving the export & handoff workflow

`npm run dev` (client `:5173`, server `:4100`), open the client URL, then:

1. **Design a restoration to a finalMesh + QC report** (any of the P4–P6
   workflows — e.g. crown: import a prep die, trace/confirm the margin, run
   inner → anatomy → morph → shell → QC). Acknowledge any failing gate the design
   honestly reports (invariant 4 — the acknowledgment is journaled; the gate
   keeps reporting `passed=false`, the report's overall `passed` flips true).
2. **Export panel** (`export-panel`, always-visible sidebar section): pick the
   restoration. An un-missable synthetic-data disclosure banner rides the panel
   (Phases 4–6 are fixture-driven until real capture — ADR-014). The QC recap
   renders the report; while a failing gate is UNACKNOWLEDGED the export is
   BLOCKED (the failing-gate list, the button disabled — no "retry until green").
3. **Export** (choose STL or PLY): the client journals the export, then posts the
   exact bytes + context to the server, which INDEPENDENTLY re-imports the bytes,
   re-runs every gate, certifies the outer envelope, and generates the
   traceability document — then either **releases** (a download link + the
   traceability HTML view + JSON download + the released hash) or shows the
   **honest mismatch** (the code, the server message, the per-field diff, the
   diagnostic bundle id — with NO retry affordance; nothing released).
   > Material note: a fresh case defaults to standard-zirconia (the QC stamp and
   > the export path share one resolver — `engine/materialProfile.ts`), so a
   > default case releases with no setup; a live picker for e.max/others is the
   > tracked carry-in (Open Item 3).
4. **Case archive** (`archive-section`): export the `.dqca` (scans + journal +
   case document + settings + QC snapshots + released exports, integrity-manifest
   sealed). Import re-CONFIRMS before overwriting an existing case (invariant 5);
   an imported case carrying release rows shows the `importedUnverified`
   provenance ("this server did NOT independently re-validate them").

See `.superpowers/sdd/p7-task-9-report.md` for the implementer's full handoff
(this task's e2e coverage detail, the profileVersion finding, and the isolated-
infra teardown), and `.superpowers/sdd/p7-task-8-report.md` + `-review.md` for
the phase-gate acceptance table and the reviewer's independent concurrence.
