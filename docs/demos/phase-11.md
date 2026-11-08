# Phase 11 — The library template on real margins (M11 "Fitted on the scan"): demo script + acceptance evidence

Phase 11 ([ADR-024](../adr/024-fold-free-emergence-outline-and-axis-tie-break.md),
[plan](../plans/phase-11-library-template-on-real-margins.md)) works on
Phase 10 open items 1, 2, 3 and 5 ([phase-10.md](phase-10.md)):

- **The emergence outline no longer folds.** It is the exact outer boundary
  of the margin's projection dilated by the emergence offset, in closed form
  (kernel 0.37.0).
- **The axis suggestion lands on a symmetric prep's axis** with no slider
  correction (kernel 0.38.0).
- **The placeholder incisors have textbook cervical proportions** (library
  asset 1.3.0). Every earlier asset version is still served.
- **CI runs the golden suite once.** The `phase3` drag flake is made
  diagnosable rather than guessed at.

## Scope, stated plainly

The phase's two clinical goals were "the fitted library template on a real
margin" and "the incisor site". Both are now **measured, and both refuse
honestly**:

- On real `arch-case-01` tooth 11 the fit now **takes** the margin (it used
  to refuse it as not star-shaped). It then refuses it **over the 50 µm
  bound**, so the built-in template is placed, with the residual shown.
- The 1.3.0 incisor on the open-arch case passes **seven of eight gates**.
  The minimum wall fails, because the open-arch die is a round,
  premolar-shaped preparation.

No gate or bound was weakened. The causes are measured and stated below.

## The five phase acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | The fit takes a real margin: on real tooth 11 the fit no longer refuses; it fits within 50 µm, or refuses `fitOverBound` with the measured residual; the outline is star-shaped and exact | **Met (the `fitOverBound` branch)** | Kernel test: tooth 11's committed trace. The old pointwise offset folds on it, and the new outline is star-shaped with every point exactly `d` from the projection (1e-12 mm). Golden real lane (`RUN_CROWN_REAL_DIE=1`, through the engine): `fitOverBound`, 178 µm. e2e `phase9-crown`: `fitOverBound`, 135 µm (same axis; canvas-click captures place the template slightly differently). The unprepared tooth's QC still fails exactly the wall and seating gates |
| 2 | The axis needs no correction: on the open-arch case, within 0.5° through the real axis tool | **Met** | `e2e/phase10.spec.ts` confirms the suggestion as is: `[-2.3e-18, -3.4e-18, 1]`, i.e. +Z to rounding. Kernel test: the open-arch height-field die, 0.000°, score 0 |
| 3 | The incisor site: a crown on 11 with the fitted library incisor passes every gate on the open-arch case, or the measured verdict is documented | **Met (documented verdict)** | `crown-open-arch-acceptance` `incisorStages` (pinned): fit residual 5.3 µm. Seven gates pass on case geometry, including self-intersection, seating and both contacts. **minWallThickness fails**, at 343 µm axial and 416 µm occlusal against 500 µm |
| 4 | Saved cases keep verifying: 1.1.0, 1.2.0 and 1.3.0 are served, and a case referencing each replays | **Met** | `STARTER_TOOTH_ASSETS_BY_VERSION` reproduces every recorded 1.1.0 and 1.2.0 metadata and mesh checksum. The server seeds all three versions. A server test serves the 1.2.0 incisor 11 by its own checksum and never the 1.3.0 bytes |
| 5 | Golden stability: pins move only under kernel 0.37.0, kernel 0.38.0 and asset 1.3.0, each proven | **Met** | 0.37.0: at 0.36.0 with the new code, only the open-arch library lane moved. 0.38.0: at 0.37.0 with the new code, only the kernel-ops `suggestAxis` hash moved, by `rankedCount` 32 → 33, with its winner bit-identical. Asset 1.3.0: no pin moved. At each bump the five `*-qc` pins and the server traceability golden moved by their version string only |

## Found during the phase

**The axis tie-break's first draft made a real suggestion worse.** The plan
put the refine cap on the overall winner. When the pole won the coarse
stage, the cap searched around the pole, and on real tooth 11 the winner
went from 0.734 to 1.660 mm³. The golden proof caught it: a moved winner
must never score worse. The cap now stays on the Fibonacci sweep's winner,
so the candidates are the old set plus the pole.
`test/golden/axis-tie-break.test.ts` recomputes the old search on the real
scan and asserts that the winner never scores worse. A by-product: the
synthetic frustum and bridge fixtures, whose ROI normal is their axis, now
get it exactly at score 0. Before, they ended 9.6° off with 28.8 mm³ left.

**Why the real margin is over the bound: mostly vertical, not the ring.**
The plan expected the template's 72-segment ring to be too coarse.
Measured:
- Horizontally, a 72-segment ring would follow tooth 11's outline within
  ~43 µm.
- In 3-D it cannot get under ~115 µm, even at uniform azimuths. The outline
  carries the incisor margin's interproximal scallop (1.37 mm of height
  around it). In the filled concavities, the nearest-point height also steps
  by up to 163 µm between neighbouring samples.
- The template's elliptical ring is less uniform, which gives 178 µm.

**Why the incisor fails the wall on the open-arch die.** The die is round,
Ø 3.8 mm at its top. The incisor's lingual fossa and thin incisal third lie
inside that radius plus the wall. A real incisor preparation is reduced
lingually and incisally. On the Phase 4 shoulder die (Ø 5 mm top, 7.5 mm
tall) the 1.3.0 incisor's cervix fits (6.8 µm), but the crown
self-intersects and has no wall over the dome. The `cervical-fit-acceptance`
golden asserts this verdict.

**The `phase3` drag flake's candidate cause is refuted.**
- The CI trace had expired (artifacts were kept 7 days).
- The log shows the drag had no effect at all.
- Measured locally, the camera is settled when the anchor is projected:
  identical right after the wheel, after two frames and after 1 s, at 1× and
  under a 4× CDP CPU throttle.
- Nothing was "fixed" without evidence. The test now attaches its drag
  inputs to every run, `DQCAD_E2E_CPU_THROTTLE` reproduces a slow runner,
  and CI keeps the artifacts 30 days.

## e2e (this phase)

| Spec | What changed | Result |
|---|---|---|
| `e2e/phase10.spec.ts` | the elevation-slider correction is gone; the suggested axis is confirmed as is (within 0.5° of +Z) | 6 / 6 ✓ |
| `e2e/phase9-crown.spec.ts` | the anatomy source is the measured `fitOverBound` (135 µm), not `fitRefused` | 4 / 4 ✓ |
| `e2e/phase3.spec.ts` | the drag attaches its inputs; optional CPU throttle | 10 / 10 ✓ (also under a 4× throttle) |
| `e2e/phase4.spec.ts`, `e2e/phase7.spec.ts` | stay on premolar 15: the 1.3.0 incisor still cannot cover the round shoulder die | ✓ |

## Full local acceptance chain

| Command | Result |
|---|---|
| `npm test` (every Vitest project, incl. golden + server + client-dom) | 373 files / 3938 passed, 26 skipped — exit 0 |
| `DQCAD_E2E_PORT=5180 npx playwright test` (every e2e spec) | 70 passed, 1 skipped (`perf.spec.ts`, env-gated as before) — exit 0 (9.2 min) |
| `RUN_CROWN_REAL_DIE=1` golden real lanes | 2 passed — die certified (0.731 mm), intaglio margin fit 0.00 µm, fit `fitOverBound` 178 µm |
| `npm run lint` | 0 errors (2 pre-existing warnings) — exit 0 |
| `npm run typecheck` / `npm run build` | clean — exit 0 / exit 0 |

The CI run is pending the push.

## Open items & tracked pendings

1. **The fitted template on a real incisor margin.** The fit's residual is
   dominated by the outline's height profile: the interproximal scallop and
   the nearest-point steps in filled concavities. A smoother outline height
   along the azimuth, or a denser template ring, is the next change. The
   bound stays at 50 µm.
2. **An incisor-shaped preparation fixture**, reduced lingually and
   incisally, to measure the incisor site on the shape it is prepared to.
   The round dies are premolar preparations.
3. **A real prepared-tooth scan** (carried over from Phase 10). The real
   cases are unprepared.
4. **The `phase3` drag flake**: read the trace of its next occurrence.
5. **CI timing**: record the job time before and after the golden suite
   runs once, on the first CI run after the push.
6. Carried over from Phase 9: a real bridge scan, a real inlay / onlay scan
   and the cusp watershed, tooth segmentation, the bridge abutment morph,
   the wide window band and the capture overlay, and open antagonist scans.

## Demo script — the axis and the fit

1. Open the open-arch prep case (as `e2e/phase10.spec.ts` generates it).
   Crown on 15, confirm the margin.
2. Axis panel: **Suggest**, then **Confirm**, with no slider. The axis is
   the die's own (+Z).
3. Crown panel: Prepare die, intaglio 60 µm, capture both neighbours, then
   **Auto-place**. The library template (FDI 15, asset 1.3.0) is fitted, and
   the readout shows the residual. Morph, shell, QC: 8 / 8. Export:
   released.
4. For the incisor: the same case with a crown on 11. The 1.3.0 incisor is
   fitted (5.3 µm). QC fails only the minimum wall, because the round die is
   a premolar preparation.
5. Real `arch-case-01` tooth 11: the fit now runs on the real margin, and
   the panel shows the built-in template with the reason "residual 135 µm >
   bound 50 µm". QC fails the wall and seating gates, because the tooth is
   unprepared.
