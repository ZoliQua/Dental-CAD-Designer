# Phase 10 — The crown on the real scan (M10 "Scan-true crown"): demo script + acceptance evidence

Phase 10 ([ADR-023](../adr/023-closed-prep-die-from-an-open-scan-and-cervical-fit.md),
[plan](../plans/phase-10-crown-on-the-real-scan.md)) closes Phase 9 open
items 1 and 5 ([phase-9.md](phase-9.md)):

- The crown designs on a **closed prep die cut from an open intraoral scan**.
  The kept scan surface is verbatim. The synthetic closure carries a measured
  clearance certificate.
- The **library anatomy is fitted to the confirmed margin**, so the library
  template is now the crown default.

## Scope, stated plainly

- The real cases (`arch-case-01`, `arch-case-02`) are scans of
  **unprepared** teeth. On `arch-case-01` tooth 11 the die and the intaglio
  are certified, and every later stage runs. The crown cannot pass the wall
  and seating gates on a tooth that was never reduced, and it does not.
- "Every crown gate passes" is therefore proven on a **closed-form open-arch
  prep case** (`packages/kernel/src/die/die.test-fixtures.ts`
  `openArchPrepCase`). It is a shouldered die and two neighbour crowns on an
  open gingival sheet with a base cut, imported as STL through the real UI.
  A real prepared-tooth scan is a tracked pending.

## The five phase acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Crown on an open scan: on the open-arch prep case, a crown built through the real path passes every crown gate | **Met** | `e2e/phase10.spec.ts`: import → crown on 15 → margin → axis → **Prepare die** → intaglio (60 µm) → both neighbours captured by canvas pick → fitted library template (the default) → morph → shell → QC **8 / 8 with no acknowledgement** → save → **export released**. `test/golden/crown-open-arch-acceptance.test.ts` (library lane, pinned): wall 643 µm, fit residual 8 µm, seating interference 6·10⁻²⁰ mm³, contact residual 0.0 µm |
| 2 | The synthetic closure is certified: every extracted die carries a measured, journaled clearance certificate, and extraction refuses visibly when it fails | **Met** | `extractPrepDie` (kernel 0.32.0). The certificate is exact on the closed-form fixture (1.171 mm, ≥ 0.25 mm required, ≥ the intaglio's 0.29 mm) and is journaled with `crown-die-extract`. `PrepDieClearanceError` / `PrepDieCoverageError` have a localized hint in the panel |
| 3 | Real scan: on `arch-case-01` tooth 11 the die is certified and the intaglio built; the later gates report honestly | **Met** | `e2e/phase9-crown.spec.ts`: die cut and certified, intaglio built on it, then anatomy, morph, shell and QC. **minWallThickness and seating fail**, visibly and acknowledgeable. The other six gates pass, and no gate was measured on a stand-in. The cervical fit refuses this margin (open item 1), so the built-in template is placed, with the reason shown. Pipeline real lane (`RUN_CROWN_REAL_DIE=1`): clearance 0.731 mm, margin fit 0.00 µm |
| 4 | Dual validation: the server re-extracts the die from the saved case and refuses an export whose die differs | **Met** | Export step 10.6 (`export-die-not-traceable` / `export-die-mismatch` with a diagnostic; `apps/server/src/export-die.test.ts`). The phase10 and phase7 e2e releases ran through the server's own re-extraction, and the dies were bit-identical end to end |
| 5 | Golden stability: existing pins byte-identical; version-only moves proven; new behaviour gets new goldens | **Met, with one deliberate numeric change** | Kernel 0.32, 0.33, 0.34 and 0.36: the whole golden suite passed at the previous version with the new code, and only the `*-qc` pins and the traceability golden moved, by their version string. **Kernel 0.35.0 changed numbers on purpose:** the transcendental functions became platform-independent (`detMath`), and the moved pins were regenerated with a changelog entry, as below |

## Found during the phase — and fixed at the root

**Transcendental functions differed between arm64 and x64 (kernel 0.35.0).**
The Linux CI had never passed the golden suite. `Math.sin`, `cos`, `atan2`,
`acos`, `exp` and `pow` differ in the last bit between Apple Silicon and x64.
That broke invariant 2, because the server may validate on a different
architecture than the client. The kernel now carries a port of FreeBSD msun
(`kernel/src/math/detMath.ts`), within 1 ulp of `Math.*` and bit-identical on
both architectures. This was proven by running the whole suite under an x64
Node. A lint rule forbids `Math.<transcendental>` and `**` in geometry code.
The CI job timeout was raised to 60 minutes, and the CI has been green since.

**The morph moved the fitted cervical ring by ~1 µm (kernel 0.36.0).** That
gave 1.3·10⁻⁴ mm³ of seating interference on the open-arch shoulder. The
morph now takes `fixedVertexIndices`, and the ring is held bit for bit.

**The UI margin repeats points** at segment boundaries, and the fit refused
it as not star-shaped. The fit now applies the same `dedupLoop` as every
other margin consumer.

**Placeholder neighbour boxes sat inside the fitted crown's cervix.** They
now flank the emergence outline, not the margin.

**The extracted die keeps whole triangles.** A coarse test die's single
1.5 mm gingival band was dropped, which left the rim on the shoulder edge with
zero clearance, and the die was correctly refused. The e2e shoulder dies now
carry intermediate collar rings, as a real scan's dense surface does.

## e2e (this task)

| Spec | What it drives | Result |
|---|---|---|
| `e2e/phase10.spec.ts` | the open-arch prep case as STL → crown on 15 → margin → axis (the real tool, elevation set to the die's axis) → Prepare die (certified, journaled) → intaglio 60 µm → capture mesial and distal by canvas pick → fitted library template (`crown-cervical-fit` journaled; the morph holds the ring; the shell trims along it) → QC 8 / 8 with no acknowledgement → save → export: no stand-in banner, server re-extracts the die and re-validates → **released** → the released STL re-imports watertight, manifold, one component | 6 / 6 ✓ (≈ 2.1 min) |
| `e2e/phase9-crown.spec.ts` (extended) | real `arch-case-01` → crown on 11 → captures → die + intaglio → **anatomy, morph, shell, QC**: exactly minWallThickness and seating fail, every other gate passes, no provenance note | 4 / 4 ✓ (≈ 1.9 min) |
| `e2e/phase4.spec.ts`, `e2e/phase7.spec.ts` | the crown on tooth 15 (Task 5): the library template is placed and the fit readout shown | ✓ |

## Full local acceptance chain (this task — explicit exit codes)

| Command | Result |
|---|---|
| `npm test` (every Vitest project, incl. golden + server + client-dom) | 372 files / 3910 passed, 25 skipped — exit 0 |
| `DQCAD_E2E_PORT=5180 npx playwright test` (every e2e spec) | 70 passed, 1 skipped (`perf.spec.ts`, env-gated as before) — exit 0 (10.1 min) |
| `npm run lint` | 0 errors (2 pre-existing warnings) — exit 0 |
| `npm run typecheck` / `npm run build` | clean — exit 0 / exit 0 |

## Open items & tracked pendings

1. **The cervical fit refuses a dense real margin.** The emergence loop
   offsets each margin point 0.65 mm outward along its local normal. On
   `arch-case-01` tooth 11 (a point every ~36 µm, concave interproximally)
   the offset loop folds back: 50 of 450 azimuth steps reverse. The refusal
   is correct and disclosed, and the built-in template is placed instead. A
   fold-free offset (a clipped or Minkowski offset of the projected margin)
   would let the library template fit real margins.
2. **The placeholder library incisor's proportions.** It is ~3 mm
   bucco-lingually against a textbook 7 mm. On a round die it
   self-intersects, so the acceptance uses a premolar site.
3. **The axis suggestion's tie-break.** On a height-field die every
   direction near the die's axis has zero undercut. The suggestion then lands
   ~12° off the axis, and the clinician has to set it with the elevation
   slider (as `e2e/phase10.spec.ts` does). A tie-break toward the margin
   plane's normal would find it.
4. **A real prepared-tooth scan** to certify the crown end to end on patient
   data (the real cases are unprepared).
5. **CI runs the golden suite twice** (inside `npm test`, then in its own
   step). This costs time, not correctness.
6. Carried over from Phase 9: a real bridge scan, a real inlay / onlay scan
   and the cusp watershed, tooth segmentation, the bridge abutment morph,
   the wide window band and the capture overlay, and open antagonist scans.

## Demo script — the crown on an open scan

1. Generate the open-arch STL from `openArchPrepCase()` (as
   `e2e/phase10.spec.ts` does), open a case and import it (role: upper jaw).
   The scan is open: one boundary loop, the base cut.
2. Restoration wizard: Crown on 15, target scan = the arch.
3. Confirm the margin (the shoulder's inner crease) and the insertion axis
   along the die (elevation 90°).
4. Crown panel, **1 · Prepared die**: the readout shows the kept and
   synthetic triangles and the clearance certificate.
5. Intaglio at 60 µm. Capture the mesial and distal neighbours with one
   click each on their crowns.
6. **Auto-place**: the panel names the library template (FDI 15, asset
   1.2.0) and shows the fit residual, the emergence offset and how far the
   ring moved. Then morph and shell.
7. QC: all eight gates pass, none acknowledged. Save, then Export. The
   server re-extracts the die from the saved scan, margin and axis,
   re-validates the exact bytes and releases the file, with no stand-in
   banner.
8. For contrast, run the same steps on real `arch-case-01` tooth 11. The die
   and the intaglio are certified. The fit refuses the margin and says why.
   QC fails the wall and seating gates, because the tooth is not prepared.
