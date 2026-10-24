# Phase 9 — Design on the real case geometry (M9 "Case-true")

Move the restoration design workflows off the fixture-era stand-ins and onto
the geometry of the case the user actually opened, per
[ADR-022](../adr/022-design-inputs-from-the-case-geometry-provenance.md).
Phases 0–8 proved every pipeline on closed-form fixtures; this phase makes
every QC verdict either a statement about the patient's geometry or
explicitly not one.

**Phase acceptance:**
1. **No silent stand-in.** No gate can pass on a `placeholder` or
   `demo-fixture` input; every such input is disclosed in its panel, the
   export panel, and the traceability document.
2. **Crown and inlay contacts on real neighbours.** On real
   `arch-case-01` (upper jaw), a crown's proximal-contact gate is measured
   against neighbour regions captured from the same scan, with a documented
   `@errorBound`.
3. **Bridge from the case.** A 3-unit posterior bridge built through the
   real path (case target scan + margin loops + shared axis + gingiva scan)
   on a new closed-form arch fixture passes all 11 bridge gates; the demo
   fixture still works, as an explicit demo mode whose QC cannot pass for
   export.
4. **Journal proves inputs.** Every bridge / crown / cavity stage op carries
   `inputHashes` for the case meshes and margin loops it consumed; replay
   reproduces identical hashes.
5. **Golden stability.** Every existing golden and dual-validation pin is
   byte-identical (the new `inputProvenance` field is omitted when all
   inputs are case-derived). New behaviour gets new goldens.

## Global constraints (bind every task)

Same as Phases 4–8: accuracy over speed; Float64 kernel; determinism and
journaling; QC gates never weakened (Decision 2 only ever makes a gate
*stricter*); clinical defaults only in `clinical-profiles/`; booleans via the
manifold wrapper; layer rule ui → engine → kernel-workers → kernel; tests
first (property + analytic golden before any real-scan fixture); every
approximation documents `@errorBound` and surfaces it in `QcReport`;
EN/HU/DE/ES for every string; **no commit trailers (author Zoltán Dul
only)**; `scans/` is PHI and never committed. A golden byte-change is an
alarm, never a regeneration — new geometry ops bump `KERNEL_VERSION` with a
changelog entry; pure UI/journal tasks must not.

**Fixture reality.** The two real cases are full-arch upper/lower + bite
scans with no preparations; they can certify neighbour and antagonist
capture, not a prep-driven bridge. The real-path bridge is therefore proven
on a new closed-form arch fixture (two prepped abutments, an edentulous
ridge, a gingiva mesh) entered through the *real* path; a real bridge scan
stays a tracked-pending.

## Task 1 — Honesty first: provenance type, disclosure, fail-closed contacts *(no new geometry)*

- `shared-types`: `GeometryProvenance`; optional `QcGateResult.inputProvenance`.
- Crown and cavity sessions tag their synthetic neighbour boxes and the onlay
  coverage divider `placeholder`; the bridge demo asset is `demo-fixture`.
- cad-pipeline contact / coverage gates fail closed on a non-`case` input,
  with a localized message naming the stand-in; acknowledgment journaled as
  today.
- Crown and cavity panels get the ADR-014 disclosure pattern for the
  stand-ins; the false "never fabricated" doc comments in `crownDesign.ts`
  and `crownGeometry.ts` are corrected.
- Export panel banner driven by the selected restoration's provenance;
  traceability document lists per-gate provenance.
- Server: the export QC context carries provenance; a context claiming
  `case` for an input the server cannot trace is rejected (dual validation
  stays dual).
- **Tests:** dom tests for each disclosure; gate tests (placeholder ⇒ fail,
  case ⇒ unchanged); a golden assertion that every existing pin is
  byte-identical; i18n parity.

**Landed (2026-10-19).** As planned, with these recorded decisions:
- The server's trace rule (`apps/server/src/export-provenance.ts`, ladder
  step 6.5, 409 `export-untraceable-provenance`): an antagonist `case` claim
  needs an `antagonist`-role scan in the saved case; a proximal-contact or
  onlay-divider `case` claim (explicit or by omission) is always refused,
  because no case-derived source exists until Task 3.
- The export suites' saved cases have no scans, so their fixture contacts are
  declared `placeholder` and the contact gate (plus the onlay covered-cusp
  gate) is acknowledged (`stand-in-provenance.testutil.ts`). The
  validate-qc dual-validation pins and every kernel / cad-pipeline golden are
  byte-identical. One server golden moved, and the change is documented:
  the crown release traceability document, where only the `contact` row
  changed (acknowledged, `placeholder`).
- The bridge is `demo-fixture` as a whole in the export banner. Its gates are
  NOT yet failed closed: that lands with the explicit demo mode in Task 6, so
  the existing bridge demo flow keeps working until then.
- The traceability schema gains the optional gate field additively, so
  `TRACEABILITY_SCHEMA_VERSION` stays 2.

## Task 2 — Cavity neighbour-side bug

`buildAdaptations` assigns mesial/distal by world `x < 0`. Use the outline
centroid along the insertion-axis-orthogonal mesio-distal direction instead.
Regression fixture: the MOD cavity translated off-origin (expected output
hash pinned) — the current code must fail it before the fix.

**Landed (2026-10-19).** `proximalSide` / `mesioDistalDirection`
(`apps/client/src/engine/cavityDesign.ts`): the face's column centroid,
taken along world X made orthogonal to the insertion axis and measured
relative to the outline centroid. The regression runs the real kernel jobs
(Node WorkerPool) on the MOD fixture translated by (23.5, −11.25, 4) mm:
before the fix both faces paired with the distal box. Pinned in
`test-fixtures/regression/cavity-neighbour-side.json`, together with the
origin-centred hash, which is byte-identical before and after the fix.

## Task 3 — Neighbour and antagonist capture from arch scans *(new kernel op → KERNEL_VERSION bump)*

- Kernel: `extractNeighbourRegion(mesh, bvh, seed, marginCentroid, axis, opts)`
  composed from the existing bounded-region / local-submesh ops; output is a
  case-derived submesh. Analytic golden first (touching spheres / boxes with
  closed-form contact distance), then `@errorBound` on missed contact
  surface.
- Worker job + engine: pick mesial / distal on the arch scan in the crown
  and cavity panels; journaled with the scan hash and pick points.
- Opposite-arch scan offered as antagonist with explicit confirmation.
- Contact gates consume the captured regions (`case` provenance); with no
  arch scan they report "no neighbour geometry in this case".
- **Acceptance (env-gated, real scans):** crown on `arch-case-01` tooth 11
  with captured 12 / 21 neighbours — contact gate measured, bound reported.

**Landed (2026-10-20, kernel 0.28.0).** As planned, with these recorded
decisions:
- The op takes the restoration's margin LOOP, not just its centroid (the
  loop's reach along the approach direction places the separating plane
  outside the restoration's own footprint). It returns a watertight solid:
  the morph and cavity contact measurements need one for the exact
  pseudonormal sign, so the verbatim window is closed by projecting it back
  along the approach direction. Window rules, closure, fold repair and
  `@errorBound` (the window-border band) are in
  `packages/kernel/src/neighbour/extractNeighbourRegion.ts` and the
  `[0.28.0]` changelog entry.
- Two findings from the real scan changed the design before landing: the
  component is chosen by area (the least-depth rule captured 1–2 noise
  triangles), and a closure fold left by the centroid visibility test is
  repaired by dropping the implicated triangles (counted and journaled), not
  refused outright.
- The antagonist uses the same op with an `occlusal` approach. Its seed is
  the margin centroid snapped onto the opposite arch, not a ray along the
  axis (on the anterior teeth that ray passes beside the lower incisors).
  It is used only after the confirm button (`ANTAGONIST_CONFIRM_OP`); an
  `antagonist`-role scan still wins without confirmation.
- Journal: one `NEIGHBOUR_CAPTURE_OP` per pick (scan mesh id in, region
  hash out, the pick and window in params); it invalidates anatomy onward
  (crown) or contacts onward (cavity). The anatomy and contacts stage ops
  list the region hashes in `inputHashes`. After a reload the captures are
  re-derived by replaying the journal, and the replay must reproduce the
  journaled hash.
- A side not captured stays a `placeholder` box; the gate message says
  "no neighbour geometry in this case" without an arch scan and "not yet
  captured" with one. A captured contact carries its band, which the
  contact gate prints. The server accepts a `case` proximal claim only with
  a capture of that side, for that restoration, from an arch scan still in
  the case.
- Acceptance (`RUN_NEIGHBOUR_CAPTURE_REAL=1`): 12 / 21 captured from the
  upper arch (2178 / 1449 triangles), the antagonist from the lower arch.
  Placement and morph run on the captured solids, and the contact gate is
  measured on `case` geometry, with the band ≤ 692 µm disclosed.

## Task 4 — Tooth library in the client

- Engine fetches anatomy for the restoration's FDI from `/api/tooth-library`
  (+ mesh bytes); client-only mode or a missing FDI falls back to the
  parametric placeholder, labelled `placeholder` in the panel.
- `@dqcad/tooth-library`: premolar and molar placeholder generators; per-asset
  provenance (generator vs scanned/licensed) in the metadata schema.
- **Tests:** offline fallback path; checksum verification of fetched assets;
  server seed includes the new FDIs.

**Landed (2026-10-24).** With one recorded decision that changes the plan:
- **The built-in template stays the default; the library template is
  opt-in.** The engine fetches the asset for the restoration's FDI
  (`engine/toothLibrary.ts`). The new `loadToothAsset` worker job verifies
  both checksums, parses the STL and gates on watertightness. The panel
  shows the asset (FDI, version, kind, provenance verbatim). Placing it is
  a journaled choice (`crown-anatomy-template`). The reason is a finding
  from the phase4 e2e: on the synthetic shoulder die, the library incisor
  gives a crown that fails structural QC (selfIntersection, seating
  175 mm³, min wall 0). The placement solve scales the template so its
  WIDEST section matches the margin, which pulls the incisor's narrower
  cervical ring inside the margin. The built-in straight-walled tooth was
  built for exactly that solve. A cervical-fit step (fit the template's
  cervical band to the margin) is the unblock; it is a tracked-pending
  item, and the library becomes the default once it lands.
- Every fallback is labelled with its reason (`notSelected`, `offline` =
  client-only deploy, `fdiMissing`, `unavailable`, `verificationFailed` with
  the loader's error named). A corrupted asset is never placed. Anatomy
  provenance is disclosed but fails no gate (ADR-022 Decision 5). The
  anatomy op journals the template source, and a placed library asset's
  mesh checksum goes into `inputHashes`.
- `@dqcad/tooth-library` 1.1.0: an optional, checksum-covered `assetKind`
  (`generator` / `scanned` / `licensed`). A placeholder provenance can only
  be `generator`. `resolveToothAssetKind` never assumes an undeclared source
  is scanned or licensed. Optional so that stored 1.0.0 assets still load
  (tested: a 1.0.0 file plus the seeded 1.1.0, latest wins). New premolar
  generator, plus the first + second molars of every quadrant (20 FDIs). The
  molar and premolar generators now share `generate/posterior.ts`; FDI 16
  is byte-identical (pinned), and so are the 1.0.0 meshes.
- Layering: `kernel-workers` → `tooth-library` is a new allowed edge
  (acyclic). The job imports the format-only `@dqcad/tooth-library/bytes`
  (no starter-set generation on worker start), and `tooth-library` takes its
  checksum primitives from `@dqcad/clinical-profiles/checksum` (the package
  index imports JSON, which the Node worker loader cannot).
- Found while verifying, not caused by this task: since Phase 8 Task 2 the
  first-run onboarding tour's backdrop blocks the phase1–7 e2e specs (they
  never dismiss it). Tracked; the phase4 spec was run with the tour
  pre-dismissed to verify this task.

## Task 5 — Ridge-crest fit *(new kernel op)*

`fitRidgeCrestCylinder(gingivaMesh, region)` — PCA over the crest region →
`RidgeCrestCylinder` consumed by the existing pontic ops. Tests first on
analytic cylinders and noisy-cylinder property tests; `@errorBound` on axis
and radius, surfaced in the pontic relief QC.

**Landed (2026-10-24, kernel 0.29.0).** As planned. The "PCA over the
crest region" is a PCA over the up-facing window's area-weighted NORMALS:
the axis is the smallest eigenvector, which is exact on a cylinder whatever
the window's shape. The cross-section is a Kåsa + Gauss–Newton circle fit.
The `@errorBound` is the measured max / RMS radial residual and the normals'
axis spread (`packages/kernel/src/bridge/ridgeCrest.ts`, changelog
`[0.29.0]`). The ponticRelief gate prints that bound when the crest was
fitted (an optional `crestFit` input, carried through the server dual
validation; byte-identical when absent). It does not enter the verdict,
because the relief is measured against the gingiva mesh itself. A hygienic
pontic shaped on the crest fitted to the bridge fixture's gingiva meets
±20 µm. The worker job and the engine wiring land with Task 6.

## Task 6 — Bridge real-geometry path

- Abutment units per abutment: shared axis from the restoration,
  `bridgeAbutmentSurfaces` job on the target scan, outer shell via the crown
  chain; per-unit dies and fit regions from the case.
- Pontic from the `gingiva` scan + Task 5 crest + Task 4 library body.
- Connector auto-placement ported from `runBridgeConnectorsStage` into a
  registered job; editor and area gate unchanged.
- Assembly, framework cutback, and QC via the existing jobs.
- Journal: every stage op carries `inputHashes` (target scan, margin loops,
  gingiva scan, library asset).
- Demo fixture moved behind an explicit "demo mode" entry (ADR-014
  disclosures kept; `demo-fixture` provenance ⇒ cannot pass for export).
- New closed-form arch fixture (generator script + serialized asset +
  drift guard) and new goldens for the real path; existing bridge goldens
  untouched.

## Task 7 — Phase gate

e2e: crown on real `arch-case-01` with captured neighbours; real-path
bridge on the arch fixture; demo-mode bridge blocked for export. Demo doc
(`docs/demos/phase-9.md`) with open items; README / PLAN status; tracked
pendings: real bridge scan, real inlay scan, automatic tooth segmentation,
cusp watershed.

## Order and dependencies

T1 → T2 (independent, small) → T3 → T4 → T5 → T6 → T7. T1 ships value on
its own (it removes the undisclosed stand-in) and is a prerequisite for
every later task, because each later task flips an input from
`placeholder` / `demo-fixture` to `case`.
