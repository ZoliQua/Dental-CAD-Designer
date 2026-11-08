# Phase 11 — The library template on real margins (M11 "Fitted on the scan")

Phase 11 implements [ADR-024](../adr/024-fold-free-emergence-outline-and-axis-tie-break.md).
It closes Phase 10 open items 1–3 and 5 ([docs/demos/phase-10.md](../demos/phase-10.md)):

- the emergence outline that folds on a dense real margin;
- the axis suggestion's tie-break;
- the placeholder incisor's proportions;
- the CI's double golden run (and the `phase3` drag flake it surfaced).

**Phase acceptance:**
1. **The fit takes a real margin.** On real `arch-case-01` tooth 11 the
   cervical fit no longer refuses the margin. The fitted library template is
   placed when its residual is within `CERVICAL_FIT_MAX_RESIDUAL_MM`
   (50 µm). Otherwise the fallback is `fitOverBound` with the measured
   residual, disclosed. Either way the emergence outline is star-shaped, and
   every outline point lies exactly `d` from the margin's projection. The
   unprepared tooth's later gates keep reporting honestly (wall and seating
   fail).
2. **The axis needs no correction.** On the open-arch prep case the
   suggested axis is the die's axis within 0.5°, through the real axis tool
   with no slider (`e2e/phase10.spec.ts` drops its correction).
3. **The incisor site.** On the open-arch prep case a crown on **11** with
   the fitted library incisor (asset 1.3.0) passes every crown gate. If a
   measurement refutes this, the golden asserts the honest verdict and the
   finding is documented, as in Phase 10 Task 3. No gate is weakened.
4. **Saved cases keep verifying.** The server serves the 1.1.0, 1.2.0 and
   1.3.0 starter assets, and a case referencing each one replays.
5. **Golden stability.** Pins move only under the three deliberate changes:
   kernel 0.37.0 (the outline), kernel 0.38.0 (the tie-break) and asset
   1.3.0. Each change is proven by running the whole golden suite with the
   new code. The moved pins are named, and every other pin is byte-identical.

## Global constraints (bind every task)

Same as Phase 10: accuracy over speed; Float64 kernel; determinism and
journaling; QC gates never weakened; clinical defaults only in
`clinical-profiles/`; booleans via the manifold wrapper; layer rule ui →
engine → kernel-workers → kernel; tests first (property + analytic golden
before any real-scan fixture); every approximation documents `@errorBound`
and surfaces it in `QcReport`; transcendentals only through `detMath` (lint);
EN/HU/DE/ES for every string; **no commit trailers (author Zoltán Dul
only)**; `scans/` is PHI and never committed. A golden byte-change is an
alarm, never a regeneration: every moved pin is explained by the task that
moves it.

## Task 1 — The fold-free emergence outline *(kernel 0.37.0)*

- `packages/kernel/src/anatomy/cervicalFit.ts`:
  - `emergenceRadius(q, c, dir, d): { radius, height }` (internal) is ADR-024
    Decision 1. It is the largest ray exit over the capsules of the projected
    margin's segments: the end-disk quadratics and the two offset lines,
    clipped to the segment's slab. The height is that of the nearest margin
    point, interpolated linearly in 3-D along the generating segment.
  - `emergenceLoop(marginLoop, insertionAxis, offsetMm)` keeps its signature.
    It returns `R(θ)` at every (deduplicated) margin point's azimuth. It
    still throws `margin-not-star-shaped` when the *margin* is not
    star-shaped, and `degenerate-margin` as before.
  - `fitCervicalRing`: ring targets come from `emergenceRadius` at each ring
    vertex's azimuth (`rayHit` on the polyline goes). The second
    `windingOrientation(loop2d)` refusal becomes an internal assertion: a
    violation is a kernel bug and throws `Error`, not `CervicalFitError`.
  - The module doc and `@errorBound` are rewritten for the exact outline.
- **Tests first** (`cervicalFit.test.ts`):
  - **Analytic.**
    - A circle of radius r gives R = r + d at every azimuth (1e-12).
    - A square margin gives the rounded square: along a corner's diagonal,
      R equals the half-diagonal plus d; along an edge normal, the half-side
      plus d.
    - A notched "plus" margin, with inner corners of radius < d, is filled:
      the outline is star-shaped, and every point lies at `dist(·, P) = d`.
      The *old* pointwise offset folds on it; keep that as the regression
      fixture.
  - **Property (fast-check).** For random star-shaped polygons (radius
    jitter up to 40 %, 16–600 points):
    - the azimuths are monotone over exactly one turn;
    - `|dist(e_i, P) − d| ≤ 1e-12`;
    - the outline is equivariant under rigid motions;
    - the outline is unchanged by repeated points.
  - **The real-margin regression.** Tooth 11's committed reference trace
    (`test-fixtures/margins/arch-case-01/11.reference.json`, no new scan
    data) with the insertion axis the golden real lane derives, recorded as
    a constant in the test (printed once from that lane). `emergenceLoop`
    used to throw on it. Now it is star-shaped and exact.
  - The existing tests are unchanged in intent. The regular-polygon test
    gains the arc between vertices.
- `KERNEL_VERSION` 0.37.0 and a changelog entry giving the numeric
  difference on the 192-gon (≤ `d(1 − cos(π/192))`, ≈ 0.09 µm).
- **Golden proof.** Run the whole golden suite and `--project server` at
  0.36.0 with the new code. Expected moves: `cervical-fit-acceptance` and
  the open-arch library lane (`crown-open-arch.json` `libraryStages`), plus
  their version-only `*-qc` / traceability pins. Any other move is an alarm.
  Re-pin, with "Advanced 0.36.0 → 0.37.0" comments.

**Landed (2026-11-08, kernel 0.37.0).** As planned, with these notes:

- `emergenceRadius(q, heights, dir, d)` works on the margin already in its
  frame (2-D points and their heights) rather than on `(q, c, dir, d)`. It is
  exported from the module for the kernel's tests, not from the package.
- The real-margin regression runs on the committed trace with zirconia's
  `d` = 0.651 mm and the axis the real lane derives at 0.36.0
  (`[-0.2211, -0.6140, -0.7577]`). The old pointwise offset folds there, and
  the new outline is star-shaped with every point `d` from the projection
  (1e-12).
- **Golden proof.** At 0.36.0 with the new code only the open-arch library
  lane moved (`anatomyPlacement`, `morphState`, `finalMesh`). Every gate
  still passes: the fit residual is 8.0 µm, the wall 643 µm, the seating
  interference 6·10⁻²⁰ mm³. `cervical-fit-acceptance` pins no hashes and
  passed unchanged. At 0.37.0 only the five `*-qc` pins and the server
  traceability golden moved, by their version string.

## Task 2 — The axis suggestion's tie-break *(kernel 0.38.0)*

- `packages/kernel/src/axis/suggestInsertionAxis.ts`:
  - The coarse candidates are `[pole, ...fibonacciHemisphereDirections(coarseCount, pole)]`.
  - Best tracking: replace on `score < best`, or on
    `score === best && dot(d, pole) > dot(best, pole)`.
  - `ranked` sorts by `(scoreMm3 asc, dot(direction, pole) desc)`, then
    generation order, so `ranked[0] === best` still holds.
  - The module doc's "Determinism & tie-break" section is rewritten.
  `suggestAxisMultiRegion` (the bridge) inherits it, and its own test
  states the pole it uses.
- **Tests first:**
  - **Sphere patch** (`suggestInsertionAxis.analytic.test.ts`): the winner
    is the pole itself, bit-exactly (it was "the pole-nearest coarse
    candidate").
  - **Height-field die:** the region of `openArchPrepCase` around its margin
    gives a best direction within 0.5° of +Z, with a score of 0.
  - **Non-tie unchanged:** the cone-frustum and the undercut cases keep
    their asserted tolerances.
  - The determinism and `ranked[0] === best` tests are kept.
- `KERNEL_VERSION` 0.38.0 and a changelog entry.
- **Golden proof** (at 0.37.0 with the new code). Expect `kernel-ops.json`
  `suggestAxis` and any golden whose axis is *suggested* (inner-surface,
  anatomy, qc-gates, crown, neighbour-capture, prep-die-real; the list is in
  `rg suggestInsertionAxis test/golden`). For every moved pin, record the
  old and new winner and its score in the changelog entry: the new winner
  must score ≤ the old one, so a moved pin means a tie or the pole won. A
  winner with a higher score is a bug.
- `e2e/phase10.spec.ts`: the elevation-slider correction goes, and the test
  asserts the suggested axis within 0.5° of +Z (phase acceptance 2).

**Landed (2026-11-08, kernel 0.38.0).** As planned, with one finding:

- **The refine cap stays centred on the Fibonacci sweep's winner, not the
  overall winner.** The golden proof caught the alarm the plan names. With
  the cap on the overall winner, a pole that won the coarse stage pulled the
  cap away from a better basin: on real `arch-case-01` tooth 11 the winner
  went from 0.734 to 1.660 mm³. Now the candidates are the old set plus the
  pole, so the winner never scores worse. `test/golden/axis-tie-break.test.ts`
  recomputes the old search on the real scan and asserts this. A kernel test
  asserts the same for poles tilted 0–40° on a frustum.
- **What moved.** The open-arch die is +Z exactly, where it was 11.7° off.
  The frustum and bridge fixtures now give their axis at score 0, where they
  were 9.6° off with 28.8 mm³ left. Real tooth 11 is unchanged. Only the
  kernel-ops `suggestAxis` hash moved, by `rankedCount` 32 → 33, and the
  `*-qc` / traceability pins moved by their version string.
- The coarse progress has one more step (the pole).

## Task 3 — The placeholder incisor's proportions *(library asset 1.3.0)*

- **Record the current versions first.** Before any generator change, add
  `RECORDED_1_2_0_METADATA_CHECKSUMS` and `RECORDED_1_2_0_MESH_CHECKSUMS` to
  `assets.test.ts` from the current build (every FDI). They prove the frozen
  tables reproduce 1.2.0 exactly.
- `packages/tooth-library/src/generate/toothParams.ts`:
  - The current tables are renamed `CENTRAL_INCISOR_PARAMS_V1` /
    `LATERAL_INCISOR_PARAMS_V1` (frozen, documented as such).
  - New `CENTRAL_INCISOR_PARAMS` / `LATERAL_INCISOR_PARAMS` (placeholder
    textbook averages, ADR-024 Decision 3):

    | Table | Cervical MD × BL | MD at contact | Incisal thickness |
    |---|---|---|---|
    | central | 7.0 × 6.0 mm | 8.5 mm | ~1.2 mm |
    | lateral | 5.0 × 5.0 mm | 6.5 mm | ~1.2 mm |

  - `generateIncisorAsset(fdi, params?)` takes the table, defaulting to the
    current one.
- `packages/tooth-library/src/assets.ts`:
  - `STARTER_ASSET_VERSION = '1.3.0'`.
  - `SERVED_STARTER_VERSIONS: readonly ['1.1.0', '1.2.0', '1.3.0']` replaces
    `PREVIOUS_STARTER_ASSET_VERSION`, with
    `STARTER_TOOTH_ASSETS_BY_VERSION: ReadonlyMap<string, ReadonlyMap<FdiTooth, StarterToothAsset>>`.
    1.1.0 and 1.2.0 incisors come from the `_V1` tables. The premolars and
    molars use the same mesh in every version.
  - The server's `seedStarterToothLibrary` seeds every served version. A
    1.0.0 file already on disk is left alone, as today.
- **Tests:**
  - The 1.1.0 and 1.2.0 recorded checksums still reproduce.
  - The 1.3.0 incisor meshes are watertight, the cervical-ring bbox is
    MD 7.00 ± 0.05 × BL 6.00 ± 0.05 mm (central) and 5.00 × 5.00 (lateral),
    and the premolar and molar mesh checksums are unchanged from 1.2.0.
  - Server: a case saved against 1.2.0 incisor 11 loads, verifies and
    replays.
  - The engine default fetches 1.3.0.
- **Golden:** `cervical-fit-acceptance.test.ts` gains the incisor lane:
  library 11 at 1.3.0 on the Phase 4 shoulder die, with a measured verdict.
  Every pin that names an incisor asset version moves; the premolar lanes
  must not.

**Landed (2026-11-08, asset 1.3.0, no kernel change).** As planned, with
these notes:

- The new tables measure as designed on the built ring: central 7.0 × 6.0 mm
  at the cervix and 8.5 mm at contact; lateral 5.0 × 5.0 and 6.5 mm; the
  incisal edge 1.0–1.5 mm thick.
- `generateIncisorAsset(fdi, table)` takes the FDI table
  (`IncisorFdiParams`). 1.2.0 rebuilds the incisors from
  `INCISOR_FDI_PARAMS_V1` and re-versions the unchanged posterior assets.
  1.1.0 is 1.2.0 without `cervicalRing`. Both reproduce every recorded
  metadata and mesh checksum. `PREVIOUS_STARTER_*` gave way to
  `SERVED_STARTER_VERSIONS` / `STARTER_TOOTH_ASSETS_BY_VERSION`, and the
  server seeds every version with its own mesh bytes.
- **The incisor lane's measured verdict on the Phase 4 shoulder die.** The
  cervix fits (residual 6.8 µm). Watertight, manifold, marginFit and seating
  pass. selfIntersection and minWallThickness fail: the round die is Ø 5 mm
  at its top, 7.5 mm above the margin, and an incisor tapers to a ~1.2 mm
  incisal edge, so it cannot cover the dome. That is the die's shape, not
  the cervix. The golden asserts this verdict, and no gate is weakened. The
  incisor site needs an incisor-shaped preparation (Task 4).
- No golden pin moved. The premolar library lanes use the same mesh, and
  only the journaled `anatomySource.version` reads 1.3.0.

## Task 4 — The library template on the real scan and on the incisor site

- **Golden open-arch** (`crown-open-arch-acceptance.test.ts`): a third
  lane, the library incisor 11 at 1.3.0 with captured neighbours. Target:
  every crown gate passes (phase acceptance 3). Pinned under
  `incisorStages`. If a gate fails, assert the measured verdict and record
  the finding, as Phase 10 Task 3 did.
- **Golden real lane** (`RUN_CROWN_REAL_DIE=1`): after the die and the
  intaglio, run the fitted library 11 through the pipeline twin's anatomy
  stage. Record the fit's residual, ring displacement and emergence. Assert
  that the outline is star-shaped and that the fit is within the bound or
  refused `fitOverBound` (phase acceptance 1).
- `e2e/phase9-crown.spec.ts`: `anatomySource` becomes
  `{ origin: 'library', fdi: 11, version: '1.3.0' }` when the fit is within
  the bound (the fit readout is visible), else `{ origin: 'builtin',
  reason: 'fitOverBound' }`. The test asserts whichever the golden real lane
  measured; there is no either-or in the test. QC: exactly minWallThickness
  and seating fail, as before.
- If the residual is over the bound on the real margin, it is because the
  template's 72-segment ring is coarser than the outline's detail. Record
  the measured figure and stop there. Refining the template ring is a new
  asset change, and it is not in this phase.

**Landed (2026-11-08, no kernel or asset change).** Measured verdicts:

- **Open-arch incisor 11 lane** (`incisorStages`, pinned). The 1.3.0 incisor
  is placed and fitted with a residual of 5.3 µm. Seven gates pass on case
  geometry: no self-intersection, margin and seating clean, both contacts
  reached. **minWallThickness fails** (343 µm axial, 416 µm occlusal, against
  500 µm). The die is round: a premolar-shaped preparation, Ø 3.8 mm at its
  top. The incisor's lingual fossa and thin incisal third lie inside that
  radius plus the wall. A real incisor preparation is reduced lingually and
  incisally, and that fixture is a tracked pending. Acceptance 3 is met as an
  honest, asserted verdict, with no gate weakened.
- **Real tooth 11** (engine lane under `RUN_CROWN_REAL_DIE=1`, and e2e
  `phase9-crown`). The fit now takes the margin, which it used to refuse as
  not star-shaped, and refuses it over the bound: `fitOverBound`, 178 µm in
  the golden and 135 µm in the e2e. The axis is the same in both, but the
  e2e captures the neighbours by canvas clicks, so the template is placed
  differently. **The cause is mostly vertical, not the ring's
  tessellation.**
  - Horizontally, a 72-segment ring would follow the outline within ~43 µm.
  - In 3-D it cannot get under ~115 µm. The outline carries the incisor
    margin's interproximal scallop (1.37 mm of height around it), and in the
    filled concavities the nearest-point height steps by up to 163 µm
    between neighbouring samples.
  - Acceptance 1 is met in its "otherwise" branch. A smoother outline
    height (or a denser template ring) is the next change, and it is not in
    this phase.

## Task 5 — CI hygiene

- `.github/workflows/ci.yml`:
  - the **Unit tests** step runs every Vitest project *except* `golden`
    (which the **Golden fixture tests** step runs). Verify that the
    project-exclusion syntax works with the repo's Vitest version. If it
    does not, list the projects explicitly, and the step's comment says
    which.
  - The job timeout stays at 60 minutes.
- **The `phase3` drag flake** (CI run 41161439808: the 7 px drag left the
  proposal unedited, twice). Debug it with the run's uploaded trace before
  any fix. The candidate cause is that the wheel zoom's camera damping is
  still animating when the anchor is projected, so the drag starts off the
  anchor. If the trace confirms it, wait in the test for the camera state
  (`getCameraState`) to settle across two frames before projecting. A
  reproduction under CPU throttling (`page.emulate` / CDP
  `Emulation.setCPUThrottlingRate` 4×) must fail before the fix and pass
  after it.
- **Success:** a CI run where the golden suite runs once and the job time
  drops accordingly; record both times.

## Task 6 — Phase gate

- Run the whole acceptance chain (Vitest, e2e, lint, typecheck, build) with
  exit codes, and get a green CI run.
- `e2e/phase10.spec.ts` (no axis correction), `e2e/phase9-crown.spec.ts`
  (Task 4) and `e2e/phase4.spec.ts` / `e2e/phase7.spec.ts`:
  - If the incisor lane passes every gate, phase4 / phase7 return to tooth
    11, and the Task 5 note in their comments is replaced.
  - Otherwise they stay on 15, with the measured reason.
- `docs/demos/phase-11.md`, with the acceptance table and the open items.
  Update the PLAN.md and README status. Close the Phase 10 open items that
  this phase resolved.

## Review focus

The inputs no task's tests may exercise, most likely to bite first:

1. **A margin whose projection is star-shaped only barely** (a near-radial
   segment). The ray–capsule exit must stay exact and finite. The property
   test's 40 % radius jitter covers this; keep a hand-built near-radial case
   in Task 1.
2. **A margin point exactly at the centroid's azimuth seam** (θ = ±π). Test
   the azimuth sampling across the seam in Task 1.
3. **A tilted margin** (heights varying around the loop) in a filled
   concavity, where the nearest-point height steps. In Task 1, assert that
   the fit still meets its bound on the Phase 10 tilted-margin case, plus a
   notched tilted variant.
4. **A bridge axis** (`suggestAxisMultiRegion`), where the tie-break applies
   to the common direction across abutments. In Task 2, assert the 14-16
   arch case's common axis, which must stay within its existing tolerance.
5. **An old case opened after the upgrade.** A case referencing 1.2.0 must
   re-verify, and its replay must not silently swap to 1.3.0. Assert this in
   Task 3's server test.
