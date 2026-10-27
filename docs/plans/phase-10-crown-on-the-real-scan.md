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

## Task 3 — Open-arch crown acceptance (built-in template)

- A golden `test/golden/crown-open-arch-acceptance.test.ts`, with the scans
  imported through STL as the app does. It runs the Task 1 fixture through
  the real engine path with captured neighbours and the **built-in**
  template. Every crown gate passes, and the stage hashes are pinned
  (`test-fixtures/golden/crown-open-arch.json`).
- An env-gated real lane (`RUN_CROWN_REAL_DIE=1`): `arch-case-01` tooth 11
  goes through extraction and the intaglio, and the certificate and the
  intaglio's margin fit are recorded.

## Task 4 — Cervical fit *(kernel 0.33.0, library asset 1.2.0)*

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
- `KERNEL_VERSION` 0.33.0 and a changelog entry. Existing placement and morph
  pins stay byte-identical, because the fit is a separate op.

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
  gate passes.

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
