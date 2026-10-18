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

## Task 4 — Tooth library in the client

- Engine fetches anatomy for the restoration's FDI from `/api/tooth-library`
  (+ mesh bytes); client-only mode or a missing FDI falls back to the
  parametric placeholder, labelled `placeholder` in the panel.
- `@dqcad/tooth-library`: premolar and molar placeholder generators; per-asset
  provenance (generator vs scanned/licensed) in the metadata schema.
- **Tests:** offline fallback path; checksum verification of fetched assets;
  server seed includes the new FDIs.

## Task 5 — Ridge-crest fit *(new kernel op)*

`fitRidgeCrestCylinder(gingivaMesh, region)` — PCA over the crest region →
`RidgeCrestCylinder` consumed by the existing pontic ops. Tests first on
analytic cylinders and noisy-cylinder property tests; `@errorBound` on axis
and radius, surfaced in the pontic relief QC.

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
