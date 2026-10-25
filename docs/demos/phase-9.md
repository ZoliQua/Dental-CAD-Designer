# Phase 9 — Design on the real case geometry (M9 "Case-true"): demo script + acceptance evidence

Phase 9 ([ADR-022](../adr/022-design-inputs-from-the-case-geometry-provenance.md),
[plan](../plans/phase-9-real-case-geometry.md)) moves the design workflows off
the fixture-era stand-ins. Every QC verdict is now either a statement about
the patient's geometry, or it is explicitly not one and fails closed.

## Scope, stated plainly

- The two real cases (`arch-case-01`, `arch-case-02`) are full-arch scans of
  unprepared teeth. They certify **neighbour and antagonist capture**, not a
  prep-driven crown or bridge.
- The bridge built from the case is therefore proven on a **closed-form arch
  case** (`packages/kernel/src/bridge/archBridge.test-fixtures.ts`: two domed
  shoulder dies in one target scan, a separate gingiva scan) entered through
  the real path. A real bridge scan is a tracked pending.
- A full-arch intraoral scan is an **open** surface. The crown intaglio's
  signed-distance offset needs a closed die, so on `arch-case-01` the crown
  stops, visibly, at the inner-surface stage (see open items).

## The five phase acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | No silent stand-in: no gate passes on a placeholder / demo-fixture input; every such input is disclosed (panel, export, traceability) | **Met** | Task 1 fail-closed gates; demo-mode bridge: every gate fails closed, the hard gates cannot be acknowledged, and the export is refused (client + server, parity-tested; `e2e/phase9.spec.ts`) |
| 2 | Crown / inlay contacts on real neighbours: on real `arch-case-01` the crown's proximal-contact gate is measured against regions captured from the same scan, with a documented `@errorBound` | **Met at the pipeline level; the UI capture is shown, the UI crown stops at the open-scan intaglio** | `test/golden/neighbour-capture-acceptance.test.ts` (`RUN_NEIGHBOUR_CAPTURE_REAL=1`): 12 / 21 captured, the contact gate measured with the window-band bound. `e2e/phase9-crown.spec.ts`: 21 and 12 are captured through real canvas picks and journaled against the scan, then the inner-surface stage refuses the open scan |
| 3 | Bridge from the case: a 3-unit posterior bridge through the real path passes all 11 gates; the demo fixture works as an explicit demo mode that cannot pass for export | **Met** | `test/golden/bridge-case-acceptance.test.ts`: every pontic style passes all 11 gates, with the scans imported through STL as the app does. `e2e/phase9.spec.ts`: through the real UI to a server-released export, and demo mode blocked |
| 4 | Journal proves inputs: every bridge / crown / cavity stage op carries `inputHashes` for the case meshes and margin loops it consumed; replay reproduces identical hashes | **Met** | Bridge stage ops journal the target scan, both margin loops, the gingiva scan, the library asset and the upstream stages. Captures journal the scan. Stage hashes are pinned from an independent run (`test-fixtures/golden/bridge-case-real-path.json`) |
| 5 | Golden stability: every existing golden and dual-validation pin byte-identical (`inputProvenance` omitted when case-derived); new behaviour gets new goldens | **Met** | Each kernel bump (0.28–0.31) was proven by running the whole golden suite at the previous version against the old pins. Only the `*-qc` pins and the traceability golden moved, and only by their embedded version string |

## Found during the phase gate — and fixed at the root

**The self-intersection predicate was wrong on near-coplanar faces (kernel
0.31.0).** The real-path bridge passed all 11 gates in Node. In the browser
it failed `selfIntersection` (4 pairs), because there the scans arrive
through STL with Float32 vertices.

Every reported pair turned out to be two faces of an offset wall, 0.06 mm
apart, coplanar to ~2 pm. The 1 pm on-plane snap put some of their vertices
on the other plane and some off it, which sent the pair down Möller's general
path; with near-parallel planes the intersection line there is meaningless.
The inner surface of every intaglio carried hundreds of such false "pairs".
The manifold clean-up hid most of them, but not all.

The predicate now judges any pair coplanar to within 1 nm by the 2-D test.
This also fixed a false negative that a new property test found. With the
fix, the inner surfaces scan clean, and the "flat die top self-overlap" noted
in Task 6 is withdrawn: it was the same false positive.

**The onboarding tour blocked the phase 1–7 e2e specs** (since Phase 8 Task
2). The new `e2e/support.ts` (`skipOnboardingTour`) marks the tour as seen
before the page loads. `e2e/phase8.spec.ts`, which tests the tour, does not
use it.

**Two e2e defects the blocked specs had been hiding**, both found when they
ran again:

- `e2e/phase5.spec.ts` ran its onlay at a 150 µm fit pitch. At that pitch the
  coarse fit surface leaves long stitch triangles at the cavity outline that
  genuinely self-intersect: 39 pairs, reproduced in Node. The geometric
  `selfIntersection` gate (kernel 0.27.0, later than the spec) is a hard gate
  and correctly cannot be acknowledged. The onlay now runs at the 60 µm
  acceptance pitch, where it is clean. This is not a regression of 0.31.0:
  the spec failed the same way with the new coplanar branch disabled.
- `e2e/phase8.spec.ts` compared the diagnostic bundle with a hard-coded
  `'0.26.0'`, stale since 0.27.0. It now uses `KERNEL_VERSION`.

`DQCAD_E2E_PORT` (default 5173) moves the e2e client when 5173 is taken. A
reused unrelated dev server would otherwise answer the specs.

## e2e (this task)

| Spec | What it drives | Result |
|---|---|---|
| `e2e/phase9.spec.ts` | arch case: import target + gingiva scans → bridge wizard → margins → **Build from this case** → every stage → QC 11/11 → save → **export released** (server re-validation, `case` claim traced to the journal) → a demo-mode bridge: every gate fails closed, export refused | 4 / 4 ✓ (build + QC ≈ 1.3 min, release ≈ 17 s) |
| `e2e/phase9-crown.spec.ts` | real `arch-case-01` upper jaw → crown on 11 → reference margin → the axis tool's real suggest + confirm → **capture 21 and 12 by canvas pick** (journaled) → the inner surface refuses the open scan, visibly | 3 / 3 ✓ |
| `e2e/phase6.spec.ts` | the explicit demo mode (now fail-closed assertions) | ✓ (unblocked by `skipOnboardingTour`) |

## Full local acceptance chain (this task, this session — explicit exit codes)

| Command | Result |
|---|---|
| `npm test` (every Vitest project, incl. golden + server + client-dom) | 362 files / 3774 passed, 21 skipped — exit 0 |
| `DQCAD_E2E_PORT=5180 npx playwright test` (every e2e spec) | 63 passed, 1 skipped (`perf.spec.ts`, env-gated as before) — exit 0 |
| `npm run lint` | 0 errors (2 pre-existing warnings) |
| `npm run typecheck` / `npm run build` | clean |

## Open items & tracked pendings

1. **Crown intaglio on an open full-arch scan.** The inner-surface offset
   needs a closed die. A real arch scan is open (`arch-case-01`: 2624
   boundary edges), and the existing repair (small-hole fill) cannot close an
   arch's base. What is needed: an open-surface offset, or a cap/die
   extraction step.
2. **A real bridge scan** (prepped abutments + edentulous ridge) to certify
   the bridge built from the case on patient data.
3. **A real inlay/onlay scan**; the onlay coverage divider has no
   case-derived source yet (cusp watershed — ADR-022 leaves it open).
4. **Automatic tooth segmentation** (captures need one pick per side today).
5. **Library anatomy fitted to the margin** (cervical fit); until then the
   built-in template is the crown default and the library template is
   opt-in (Task 4).
6. **Bridge abutments: the morph step and outer-neighbour capture.** The
   abutments of a bridge built from the case are not morphed, because their
   outer neighbours are not captured yet.
7. **Wide window band on the real scan** (captured regions disclose up to
   ~0.7 mm), and **no viewport overlay** of the captured regions yet.
8. **Antagonist-role open scans** are not watertight (the antagonist contact
   on such a scan works through the opposite-arch capture instead).

## Demo script — the bridge built from the case

1. Open a case and import `arch-14-16.stl` (role: upper jaw) and
   `gingiva-15.stl` (role: gingiva). Both are generated from
   `apps/client/src/engine/archBridgeFixture.asset.json` (see
   `e2e/phase9.spec.ts`).
2. Restoration wizard: Bridge; 14 and 16 are abutments, 15 is the pontic;
   target scan = the arch.
3. Confirm the abutment margins (the shoulder rings).
4. Bridge panel: pitch 60 µm → **Build from this case**. The panel shows what
   the build consumed: the crest-fit residual, and the pontic body (the
   tooth-library asset).
5. Commit the abutment surfaces, then the pontic (any style), preview and
   commit the connectors, select full contour, assemble, and run QC: all 11
   gates pass.
6. Save, then Export: the server re-imports the bytes, re-runs every gate,
   traces the bridge's `case` claim to the journal, and releases the file.
7. For contrast, the same panel's **Demo mode** runs the demonstration bridge
   under its banner. Every gate fails closed, and Export refuses it.
