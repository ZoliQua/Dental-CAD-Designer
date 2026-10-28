# Phase 10 — The crown on the real scan (M10 "Scan-true crown")

The crown workflow gets two things, per
[ADR-023](../adr/023-closed-prep-die-from-an-open-scan-and-cervical-fit.md).
It designs on a closed prep die extracted from an open intraoral scan. And its
library anatomy is fitted to the confirmed margin, so the library template can
become the default. These close Phase 9 open items 1 and 5
([docs/demos/phase-9.md](../demos/phase-9.md)).

**Phase acceptance:**
1. **Crown on an open scan.** On a new closed-form **open-arch prep case** (a
   shouldered prepped die with neighbours, embedded in an open arch surface
   with a base cut), a crown built through the real path passes every crown
   gate. The real path is: import, then the target scan, the margin, the
   axis, die extraction, the intaglio, the library anatomy with cervical fit,
   the morph against captured neighbours, the shell and QC.
2. **The synthetic closure is certified.** Every extracted die carries a
   clearance certificate. It holds on the fixture, and it is measured and
   journaled. When the certificate fails, extraction refuses visibly.
3. **Real scan.** On real `arch-case-01` (tooth 11), die extraction succeeds
   with its certificate, and the intaglio is built on the real scan. The
   gates after it report honestly. The tooth is unprepared, so the thickness
   and seating gates are expected to fail, visibly, with no stand-in.
4. **Dual validation.** The server re-extracts the die from the saved case
   and refuses an export whose die hash differs from the client's.
5. **Golden stability.** Every existing kernel, pipeline and bridge pin is
   byte-identical. Version-only moves are proven as in Phase 9. New behaviour
   gets new goldens.

## Global constraints (bind every task)

Same as Phase 9: accuracy over speed; Float64 kernel; determinism and
journaling; QC gates never weakened; clinical defaults only in
`clinical-profiles/`; booleans via the manifold wrapper; layer rule ui →
engine → kernel-workers → kernel; tests first (property + analytic golden
before any real-scan fixture); every approximation documents `@errorBound` and
surfaces it in `QcReport`; EN/HU/DE/ES for every string; **no commit trailers
(author Zoltán Dul only)**; `scans/` is PHI and never committed. A golden
byte-change is an alarm, never a regeneration.

## Task 1 — `extractPrepDie`: a closed prep die from an open scan *(kernel 0.32.0)*

- `packages/kernel/src/die/extractPrepDie.ts`:
  - **Region selection:** whole triangles, in the margin's connected
    component, inside the margin-polygon footprint plus `radialSkirtMm`
    (measured in the axis frame) and above the floor of `depthSkirtMm` below
    the lowest margin point.
  - **Closure:** the rim is extruded along `−axis` to the floor plane, with a
    planar cap, reusing the `closeRegion` machinery.
  - **Validation:** watertight, manifold, geometric self-intersection scan,
    volume > 0.
  - **Certificate:** the exact minimum distance from the synthetic triangles
    to the intaglio's evaluation region and the crown footprint, which must
    exceed `requiredClearanceMm`; otherwise `PrepDieClearanceError` with the
    measured value.
  - Typed errors for every failure (empty region, rim not a single loop,
    certificate failed).
- **Tests first:**
  - an analytic open-arch fixture (`die.test-fixtures.ts`: a shoulder-prep
    die and two neighbour domes on an open, wavy gingival sheet with a base
    cut). The kept surface is byte-equal to the source triangles, the volume
    of the closed die is pinned against its closed form, and the neighbours
    are excluded.
  - Property tests: translation and rotation equivariance, determinism, and
    the certificate monotone in the skirt parameters.
  - Fail-closed cases: a margin touching the base cut, and a skirt too small
    for the clearance.
  - An already closed single die (the Phase 4 shoulder die) round-trips
    through the same op.
- `KERNEL_VERSION` 0.32.0 and a changelog entry. Existing pins stay
  byte-identical, which a full golden run proves.

**Landed (2026-10-27, kernel 0.32.0).** As planned, plus one finding from the
real scan:
- **Rim fold repair.** On real `arch-case-01` tooth 12, the cut rim folds in
  projection: the scan turns under itself along the axis, so two rim edges
  cross. The op now drops the kept rim triangles implicated in a crossing
  rim edge or a degenerate or self-intersecting closure face, and rebuilds the
  region, up to `PREP_DIE_MAX_FOLD_REPAIR_ROUNDS` (64) rounds. The count is
  returned (`foldTrianglesDropped`), and the certificate is measured on the
  final rim. A synthetic regression (one rim vertex moved past its
  neighbour) fails without the repair.
- **The floor cap** is a strict ear clip. A vertex within 1 nm of a
  candidate ear blocks it, and a stall throws; it never falls back to a fan.
- **Real `arch-case-01`** (`test/golden/prep-die-real.test.ts`, gated by
  `RUN_PREP_DIE_REAL=1`): closed, certified dies for teeth 11, 12 and 21,
  with clearance 0.73, 0.51 and 0.66 mm, each built in under 0.5 s.
- **Golden proof.** The whole golden suite passed at 0.31.0 with the new
  code. At 0.32.0 the five `*-qc` pins and the server traceability golden
  moved, version-only: replacing "0.32.0" with "0.31.0" reproduces the old
  hash. Full Vitest: 3789 passed, 24 skipped; lint and typecheck clean.

## Task 2 — The crown designs on the extracted die *(no new geometry)*

- Worker job `extractPrepDie`, with progress and cancellation and a
  byte-identity test against the in-process call.
- `crownDesign.ts`:
  - a new **Prepare die** step between the axis and the intaglio, showing the
    kept and synthetic triangle counts, the skirts and the certificate;
  - journaled op `crown-die-extract`;
  - the intaglio, seating QC, export `dieSolid` and the anatomy height (along
    the axis) all use the extracted die;
  - replay reproduces the die hash.
- The pipeline twin (`cad-pipeline` innerSurface stage and `runCrownQc`)
  takes the extracted die.
- Server: `/validate-qc` and the export route re-extract the die from the
  saved case's scan, margin and axis, and compare its hash. A mismatch gives
  409 `export-die-mismatch` with a diagnostic bundle.
- i18n for the step, the readout and every error, in all four languages.
- **Tests:**
  - engine tests for the step, its journal entry and replay;
  - a DOM test for the panel;
  - server tests for re-extraction and the mismatch refusal;
  - the crown QC pins that move only by `dieSolid` or the version string are
    proven version-only or documented.

**Landed (2026-10-27, kernel 0.33.0).** As planned, with these findings and
decisions:
- **The persisted form.** The server holds a scan only as binary STL
  (float32, re-welded on reload), so a die cut from the client's Float64
  scan could not be reproduced there. The job and the server both cut the die
  from `persistedMeshForm(scan)`. It equals the real save-and-reload jobs'
  mesh, which a kernel-workers test proves, and it is idempotent, so a
  reopened case replays the identical die.
- **The closed passthrough.** The Phase 4 dies (and the server crown fixture)
  are closed scans lying wholly within the skirts. `extractPrepDie` used to
  refuse them ("0 rim loops"). Now the kept surface passes through as the
  die, with no synthetic part and an unbounded certificate, as the ADR
  states. Inputs that extracted before extract identically.
- **The coverage check.** The die's certificate is checked against the
  intaglio actually built: clearance ≥ the larger gap + 4 pitches, and a
  protected band ≥ the crop band (`PrepDieCoverageError`, raised by the
  `innerSurface` job before any work).
- **Margins must be on the scan.** A die needs every margin point within
  0.1 µm of the kept surface. The margin editor's snapped points are; an
  analytic circle on a faceted test die is not (up to 0.64 µm inside the
  chords). The browser test and the server fixture now use the die's rim
  vertices for the die margin. The tolerance is unchanged.
- **Coarse test dies.** The e2e shoulder die's gingival collar was a single
  1.5 mm band. The die keeps whole triangles above its depth skirt, so that
  band was dropped and the cut rim sat on the shoulder edge with a clearance
  of 0, and the die was refused, correctly. The e2e collar now carries two
  intermediate rings, as a scan's dense surface does. Phase 7's export then
  released through the server re-extraction: the client and server dies are
  bit-identical end to end.
- **The engine.** A new first stage, **1 · Prepared die** (the stage titles
  are renumbered 1–7). It is journaled as `crown-die-extract` with the scan
  mesh id in, the die hash out, and the margin, axis, skirts, certificate and
  counts as params. It invalidates the intaglio onward. On reload the die is
  re-derived by replay and must reproduce `stages.prepDie`
  (`CrownDieReplayMismatchError` otherwise). The anatomy height is measured
  on the die along the axis. Every die error has a localized hint in the
  panel.
- **The server.** Export step 10.6 re-extracts the die from the saved scan,
  margin and axis, and refuses `export-die-not-traceable` /
  `export-die-mismatch`, the latter with a persisted diagnostic.
  `/validate-qc` has no case reference, so it stays a stateless parity
  endpoint (ADR-023 updated). The pipeline twin needs no change:
  `runCrownQc` already takes the die, and the innerSurface stage takes the
  die as its target mesh. A pipeline die stage lands with Task 3's golden.
- **Real scan (e2e phase9-crown).** On arch-case-01 tooth 11 the die is cut,
  certified, and the intaglio is built on it through the real UI. Before,
  that stage refused the open scan.
- **Golden proof.** The whole golden suite passed at 0.32.0 with the new
  code. At 0.33.0 the five `*-qc` pins and the server traceability golden
  moved, version-only (replacing "0.33.0" with "0.32.0" reproduces the old
  traceability hash).

## Task 3 — Open-arch crown acceptance (built-in template)

- A golden `test/golden/crown-open-arch-acceptance.test.ts`, with the scans
  imported through STL as the app does. It runs the Task 1 fixture through
  the real engine path with captured neighbours and the **built-in**
  template. Every crown gate passes, and the stage hashes are pinned
  (`test-fixtures/golden/crown-open-arch.json`).
- An env-gated real lane (`RUN_CROWN_REAL_DIE=1`): `arch-case-01` tooth 11
  goes through extraction and the intaglio, and the certificate and the
  intaglio's margin fit are recorded.

**Landed (2026-10-28, no kernel change).** The golden
`test/golden/crown-open-arch-acceptance.test.ts` runs the open-arch fixture
through the real crown controller on a Node worker pool. The steps are:
STL import, Prepare die, intaglio (60 µm pitch, journaled), capture of 21 and
12 with one pick each, the built-in anatomy, morph, shell and QC. Its stage
hashes are pinned (`test-fixtures/golden/crown-open-arch.json`) from an
independent run. Findings and decisions:
- **The die is certified on the fixture.** 5184 kept triangles, 574
  synthetic, no fold dropped, a clearance of 1.171 mm (≥ 0.25 mm required
  and ≥ the intaglio's 0.29 mm), a floor 1.25 mm below the margin.
- **Seven of eight gates pass on case geometry.** These are watertight,
  manifold, self-intersection, margin fit (0.00 µm), seating on the extracted
  die, connector (N/A), and contact against the captured neighbours (0.0 µm
  residual).
- **`minWallThickness` fails, honestly.** The built-in template is cut by a
  plane at the margin, so its cervical wall is a wedge. It measures 0.20 mm
  at 0.2 mm above the margin, just outside the profile's 0.2 mm finish-line
  band. Measured on the crown solid as built (outer surface plus seam), the
  value is the same. `autoThicken` cannot help: the shell's own thickness
  readout measures only the trimmed outer surface (1.99 mm here), not the
  seam band that forms the wedge. The gate is right, and nothing was
  weakened. The fix is Task 4's cervical fit. The plan's "every crown gate
  passes" for the built-in template is refuted by measurement, so the golden
  asserts the honest verdict, and the all-gates lane moves to Task 5's
  fitted library template. That lane is phase acceptance 1.
- **The pipeline die stage.** `runPrepDieStage` (cad-pipeline) is the
  pipeline twin of the engine stage. It cuts from the persisted form with
  the confirmed margin as given and journals under `crown-die-extract`. The
  golden proves it reproduces the engine's die hash, so the engine, the
  pipeline and the server (export-die.test.ts) cut the same die.
- **Real lane (`RUN_CROWN_REAL_DIE=1`).** arch-case-01 tooth 11 runs through
  the pipeline twin: die stage, coverage check, then the intaglio on the die
  with its margin-fit gate. Measured: 16375 kept triangles, 841 synthetic,
  no fold dropped, a clearance of 0.731 mm (0.4 s); the intaglio has 53518
  triangles at 60 µm (21 s), with a margin fit of 0.00 µm on the 450-point
  loop. The engine on this scan is covered by e2e phase9-crown.

## Task 4 — Cervical fit *(kernel 0.34.0, library asset 1.2.0)*

- Tooth-library schema: an optional `cervicalRing` (ordered vertex indices).
  The generators emit it, assets are versioned 1.2.0, the server seeds them,
  and 1.1.0 assets still load and verify.
- Kernel `anatomy/cervicalFit.ts`:
  - the emergence loop is the margin offset by the marginal gap plus the
    material's minimum margin thickness (from the profile);
  - ring-to-loop pairing by azimuth;
  - an RBF warp with far-field anchors above `cervicalBlendMm`;
  - `@errorBound` = the maximum ring-to-loop residual, reported.
- Shell: for a fitted template, the margin-following trim (the fitted ring is
  the outer rim). The plane trim is unchanged for everything else.
- **Tests first:**
  - analytic: an elliptic-cylinder template fitted to a circular margin, and
    a circular template fitted to a tilted (non-planar) margin, with residuals
    against the closed form;
  - property: determinism, equivariance, and no motion above the blend;
  - the library incisor on the phase-4 shoulder die now passes the
    minimum-wall, seating and self-intersection gates. These are the gates
    that failed in Phase 9 Task 4.
- `KERNEL_VERSION` 0.34.0 and a changelog entry. Existing placement and morph
  pins stay byte-identical, because the fit is a separate op.
- From Task 3: the margin-following trim must give the cervical wall the
  profile minimum just outside the finish-line band. The open-arch crown's
  plane-trimmed wedge (0.20 mm at 0.2 mm above the margin) is the regression
  case.

## Task 5 — The library template becomes the crown default

- `crownDesign.ts`:
  - the library template, fitted, is the default when its asset is verified,
    has a `cervicalRing` and fits within the bound;
  - otherwise the built-in template is used, with the reason disclosed;
  - the opt-out stays, journaled.
- The panel shows the fit residual.
- Update the affected tests: the default-template unit test, e2e phase4's
  auto-place and phase7.
- The golden from Task 3 gains a library lane, pinned, in which every crown
  gate passes (phase acceptance 1). The built-in lane keeps its honest
  verdict (its cervical wedge fails `minWallThickness`).

## Task 6 — Phase gate

- e2e `phase10.spec.ts`. On the open-arch fixture through the real UI: import
  the STL, crown, margin, axis, **Prepare die**, intaglio, capture the
  neighbours, library anatomy fitted, morph, shell, QC with every gate
  passing, save, and an **export released** after the server re-extracts the
  die.
- e2e `phase9-crown.spec.ts` is extended. On real `arch-case-01`, the crown
  now passes extraction and the intaglio, and the later gates' verdicts are
  asserted as honest (unprepared tooth).
- Run the whole acceptance chain (Vitest, e2e, lint, typecheck, build) with
  exit codes.
- `docs/demos/phase-10.md`; PLAN.md and README status updated.
