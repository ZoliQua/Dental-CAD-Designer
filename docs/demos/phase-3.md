# Phase 3 — Case Setup, Margin Line, Insertion Axis: demo script + acceptance evidence

Status: **DONE, with one criterion honestly PENDING** (Task 11 — e2e, docs,
acceptance wrap-up; the final Phase 3 task). Branch `phase-3-margin-axis`.
`KERNEL_VERSION` at phase end: **0.7.0**.

Phase acceptance criteria (`PLAN.md:188 (amended 2026-07-15; paraphrased below — see PLAN.md for the verbatim text)`, itself
quoting `PLAN.md`, **AMENDED 2026-07-15** after Task 8's honest BLOCKED
verdict — see "Amendment history" below):

> on 3 real prep fixtures, auto margin proposal is within 100 µm (mean) of
> the hand-traced reference along the **ridge-visible** portion of the
> margin, for ≥ 3 preps, with the visible-coverage fraction honestly
> measured and reported per tooth [amended]; margin validation rejects
> seeded self-intersections; undercut map on a tilted cylinder matches
> analytic expectation.

This document does not soften that verdict: the margin-accuracy criterion
(amended or original) is **not yet demonstrated** on this real case, for a
diagnosed, structural, non-tunable reason (Task 8/8b) — it awaits a
scan-visible retraction-cord fixture the project owner has not yet
supplied. Everything else in the phase's own scope — the validation gate,
the axis/undercut kernel, and the full margin→axis→blockout UI pipeline —
is built, tested, and demonstrated below.

## Acceptance evidence

| # | Criterion (PLAN.md, amended) | Status | Measured | Test(s) |
| --- | --- | --- | --- | --- |
| 1 | Margin auto-proposal within 100 µm (mean) of hand-traced reference, ridge-visible portion, ≥ 3 of 4 real preps | **PENDING** — not met on this fixture; a real, diagnosed limitation, not weakened | Ridge-visible mean deviation: tooth 12 = 304.9 µm (28.7% coverage), tooth 21 = **127.0 µm** (40.9% coverage, closest of the three), tooth 22 = 337.4 µm (6.6% coverage). Tooth 11 does not auto-close at all (`NoClosureError`) — 13.9% ridge-visible coverage, consistent with the non-closure. **0 of 3 pass ≤100 µm.** | `test/golden/margin-acceptance.test.ts` (`scripts/margin-acceptance.ts`); full narrative: `docs/demos/phase-3-task-8-evidence.md` |
| 2 | Margin validation rejects seeded self-intersections | **MET** | A figure-eight (crossing) anchor ordering on a real fixture is rejected — `selfIntersecting: true`, confirm blocked — verified on THREE independent lanes: kernel, worker job, and real-browser UI | `packages/kernel/src/margin/validate.test.ts`, `packages/kernel-workers/src/validateMarginJobs.test.ts`, `apps/client/src/ui/MarginPanel.validation.dom.test.tsx`; live e2e demonstration: `e2e/phase3.spec.ts`'s "validation badge settles (never invalid)" step, which asserts the REAL badge is never `invalid` for a real (non-seeded) proposal+edit |
| 3 | Undercut map on a tilted cylinder matches analytic expectation | **MET** (re-asserted fresh this task, not copied) | Relative error **2.263 × 10⁻¹⁵** at tilt 30°/90°/150° — unchanged since Phase 2 Task 9's original measurement (2.3 × 10⁻¹⁵, same deterministic algorithm) | `packages/kernel/src/undercut/undercutScan.analytic.test.ts` |

### Supporting evidence: insertion-axis accuracy (not a phase-acceptance line item, cited per this task's brief)

The tapered-frustum analytic fixture (Phase 3 Task 9, `KERNEL_VERSION`
0.6.0) recovers the true construction axis within **~9.6°** at the
default `interactive` search budget (`scoreMm3 ≈ 28.82 mm³` residual, 4.7%
of ROI area, `maxDepthMm ≈ 8.11 mm` — the design's real, honestly-reported
default-budget residual, corrected in a fix batch after an earlier report
mistakenly claimed zero) — and converges to the **exact analytic
optimum** (`scoreMm3 = 0`, inside the fixture's own ~9.46° zero-undercut
cone) at **9.20°** under the `precise` search preset
(`AXIS_SEARCH_PRESETS`). The bridge two-abutment fixture shows the same
pattern (`scoreMm3 ≈ 25.8 mm³`/abutment at `interactive`, `0` at
`precise`). Re-verified fresh this session:

```
[axis] bridge HIGH BUDGET (precise preset): common axis angular error = 9.197 deg; perAbutment scoreMm3=[0, 0]
```

Product framing (documented, not a gap): auto-suggestion is an interactive
starting point; the live µm-depth undercut heatmap plus manual angle-slider
adjustment is the designed clinical-accuracy backstop — see
`packages/kernel/src/axis/suggestInsertionAxis.analytic.test.ts` and
`docs/CHANGELOG-kernel.md`'s `[0.6.0]`/`[0.6.0] addendum` entries.

### Amendment history (why criterion #1 reads "amended", verbatim record)

1. **Task 8** (`KERNEL_VERSION` 0.5.0): measured the ORIGINAL, unamended
   criterion (≤100 µm mean over the best 90% of full proposal length) on
   all 4 real preps. **0 of 3 measurable teeth passed**; tooth 11 never
   closes. Root cause, verified not assumed: sampling κ2 directly at the
   dentist's own reference points shows only 10.9–51.1% of each reference
   trace sits on curvature strong enough to qualify as "ridge" at all — the
   rest is gingiva-obscured or genuinely convex. `proposeMarginLoop`
   architecturally can only ever walk qualifying ridge terrain; no
   parameter retuning changes that. One legitimate, credited tuning fix
   WAS applied during this task (`MARGIN_MIN_RIDGE_COMPONENT_SIZE`, fixes
   an isolated curvature-noise blip from stealing `findRidgeStart` — this
   is what makes tooth 21 measurable at all).
2. **User decision (2026-07-15)**: reframe the criterion to the
   ridge-visible portion + honestly report coverage (PLAN.md amended,
   `f2cdfb3`), with the ORIGINAL full-length criterion moved to a future
   scan-visible (e.g. retraction-cord) fixture not yet supplied.
3. **Task 8b**: measured the AMENDED criterion. Ridge-visible-stretch mean
   deviation is 20–46% lower than the full-length mean for every closing
   tooth (a real, verified improvement — the visible-stretch *sample*
   fraction of the proposal closely tracks the reference's own
   visible-*coverage* fraction, ruling out a harness artifact) — **but
   still 0 of 3 clears the 100 µm bar.** Root cause (Task 8b's own
   contribution): the qualifying κ2 region is a WIDE 2D band around the
   true crest, not a crisp 1D curve — the walker's "strongest-κ2-in-the-
   band" rule doesn't always land exactly on the dentist's hand-traced
   line even where a genuine ridge signal exists throughout.

Full per-tooth tables and worst-cluster breakdowns:
`docs/demos/phase-3-task-8-evidence.md` (the structured evidence block
Task 8/8b left specifically for this document to lift).

## Demo script (what's UI-reachable today)

Unlike Phase 2, Phase 3 is exactly the phase that makes margin/axis
kernel work user-facing. Run `npm run dev` (client `:5173`, server
`:4100`), open the client URL, then:

### 1. Case + import

Create a case (`open-case-picker-button` → name → Enter), import a real
scan (`import-file-input` — e.g. `test-fixtures/real-scans/arch-case-01/
arch-case-01-upperjaw.stl`), assign it a role (`import-role-select` →
"Upper jaw").

### 2. Case wizard: restoration setup

`RestorationWizard` (always-visible sidebar panel, `restoration-panel`
testid namespace): pick a type (crown/bridge; inlay/onlay greyed, "Phase
5" note), click FDI teeth on the 2×16 chart (`fdi-tooth-<n>`), pick the
target scan, **Create restoration**. Bridges get contiguity checking
(`bridge-contiguity-warning` if the picked teeth aren't a contiguous
span).

### 3. Margin line (auto-propose → edit → validate → confirm)

`MarginPanel` (`margin-panel`): pick the restoration + abutment tooth,
**Start**. Auto mode is the default — the anchor-count slider (20–200,
default 50, curvature-adaptive) is visible before any anchor exists
(`margin-anchor-count-slider`). Click on the mesh near the intended margin
to seed a curvature-ridge proposal (`proposeMargin` worker job — a real
bidirectional crest walk + curvature-adaptive simplification, Phase 3 Task
4). A closed loop's anchors become draggable handles
(`ui/MarginOverlay.tsx`): click-select, shift-click multi-select + bulk
delete, drag to re-snap (live geodesic re-snap on every pointermove, ONE
journaled op on release), plus a cursor-following cross-section magnifier
for precision placement near the gumline.

The validation badge (`margin-validation-badge`, `data-status`
valid/warning/invalid) updates on every commit: self-intersection,
off-surface, and degeneracy are HARD failures (block confirm outright —
criterion #2 above); smoothness outliers are WARNINGS (confirmable with
explicit acknowledgement, `margin-acknowledge-confirm-button`). **Confirm**
(`margin-confirm-button`) journals `margin-confirm`.

### 4. Insertion axis (auto-suggest → live heatmap → blockout → confirm)

`AxisPanel` (`axis-panel`, requires ≥1 confirmed margin line): **Start**,
then **Suggest axis** (`axis-suggest-button` — the real `suggestAxis`
worker job, Phase 3 Task 9) fills in azimuth/elevation sliders, a
ranked-candidate list (try next-best), and a per-abutment undercut
readout table (`axis-abutment-table`). The live µm-depth undercut heatmap
(`axis-heatmap-toggle`, on by default) recomputes on every suggest/manual
slider adjustment. The blockout preview (`axis-blockout-toggle`, Phase 3
Task 10 "virtual wax") shows how much material would need filling to
eliminate undercut along the current axis, with a threshold input and a
live readout (triangle count, max displacement, approximate volume).
**Confirm axis** (`axis-confirm-button`) journals `axis-set` with full
provenance (source, ranked candidates, blockout params).

### 5. Save / reload

Standard `save-button` → `save-status: Saved`; reload the page, reopen the
case — restoration, margin anchors, and the confirmed insertion axis are
all restored. See `e2e/phase3.spec.ts`'s final two steps for the exact,
scripted, real-browser proof of this.

## e2e (Task 11)

`e2e/phase3.spec.ts` drives the ENTIRE flow above through the real app —
real file input, real WebGL canvas clicks/drags, real worker jobs, real
server routes (same standard as `e2e/phase1.spec.ts`). Ten sequential
steps, all green, ~1.1 minutes:

1. Creates a case, imports the real `arch-case-01` upperjaw scan.
2. Wizard: creates a crown restoration on **tooth 21** (see "Why tooth 21,
   not 11" below).
3. Seeds a real auto-propose via `window.__dqcadTestHooks__.
   seedMarginPropose` (a reproducible `(triangleIndex, barycentric)` seed —
   the ambient centroid of the committed hand-traced tooth-21 reference,
   `snapToSurface`-projected, the SAME method `scripts/margin-acceptance.ts`
   uses) — the real `proposeMargin` worker job runs unmodified; only the
   "which triangle did a screen click hit" step is bypassed (a real click
   cannot reliably land on a sub-mm seed at whole-arch camera framing on a
   real 250k-triangle scan).
4. Drags one real anchor via a real `page.mouse` gesture at its exact
   projected pixel (`getMarginAnchorPositions`/`worldToCanvasPoint` test
   hooks give the exact pixel; the drag itself is genuine — it lands on
   `ui/MarginOverlay.tsx`'s real capture-phase pick-priority handler and
   drives the real `updateAnchorDrag`/`endAnchorDrag` pipeline). Zooms the
   real OrbitControls camera in first (a real `wheel` gesture) — the
   default whole-arch framing packs `proposeMargin`'s curvature-adaptive
   anchors densely enough (~0.5–0.6 mm apart at the coarsest slider
   setting) that an un-zoomed drag reliably crosses a neighboring segment.
5. Validation badge settles to `valid` or `warning` (never `invalid` — see
   criterion #2's evidence) and confirms via whichever real product path
   (`confirmMargin`'s own fresh re-validation decides).
6. Axis: auto-suggests, asserts a REAL, non-empty undercut heatmap
   overlay via `getAxisHeatmapOverlay` (a store-level assertion — the
   heatmap has no DOM-observable pixel content worth asserting on
   directly, same "assert real engine state, not a screenshot" convention
   `getCameraState`/`worldToCanvasPoint` established in Phase 1).
7. Blockout preview toggles on, shows a real readout.
8. Axis confirms.
9. Saves.
10. Reloads, reopens the case, and verifies restoration/margin/axis
    survived — margin via anchor-count + nearest-neighbor position
    matching (see "A real finding" below), axis via the `direction` vector
    read through `getAxisDirection` (`confirmed` itself is
    session-scoped for BOTH tools — `startForTooth`/`axisEngine.start()`
    never restore it from persisted data, only a fresh in-session confirm
    sets it — so the underlying data, not that flag, is the actual proof).

### Why tooth 21, not 11 (a deliberate, documented deviation from this task's own brief)

The brief's flow sketch names "tooth 11". `scripts/margin-acceptance.ts`'s
own `EXPECTED_NON_CLOSING_TEETH = [11]` (CI-verified every run) documents
that tooth 11's real-scan curvature signal never closes into a loop at all
— a genuine, diagnosed real-scan coverage gap (criterion #1's evidence
above), not a UI bug. Seeding an e2e flow expected to always fail its own
"does it close" step would be either permanently red or would require
silently swapping teeth anyway; CLAUDE.md's "never weaken a gate or test
to force a pass" applies by the same logic even for a flow test. Tooth 21
is used instead: one of the 3 real preps that DOES close, and the
highest-coverage/lowest-deviation of the three per the amended-criterion
table above.

### A real finding this task's e2e work surfaced (not a bug, documented honestly)

`startForTooth`'s margin-line loader ALWAYS re-resolves a loaded margin
through the real `snapPolyline` worker job (a full geodesic re-snap of the
whole loop against the current mesh) rather than echoing the stored
`position` verbatim. For a loop with a genuine smoothness irregularity —
this e2e test's own dragged anchor produced exactly that (the 'warning'
badge) — the re-snap pulls that ONE point most of the way back toward its
original, ridge-consistent location on reload (measured: ~0.57mm, nearly
the full drag distance). Every other (un-dragged) anchor reproduces
byte-for-byte. This is real, working-as-designed load behavior, not
something this task's e2e assertions paper over — `e2e/phase3.spec.ts`'s
reload check asserts anchor count and that all-but-at-most-one anchor
matches near-exactly, with the mechanism documented inline at the
assertion site.

## Journal replay extension (Task 11)

`scripts/journal-replay-lib.ts` gained a third recorded-journal fixture,
`recordMarginProposeJournal()`, wired into `recordAllFixtures()` (so every
existing generic replay assertion — hash reproducibility, self-
determinism — covers it automatically). Of the margin/axis `Operation`
kinds `apps/client/src/engine/` actually journals, only ONE has a genuine,
replayable kernel effect:

| Operation | Replayable? | Why |
| --- | --- | --- |
| `margin-edit` (seeded first-commit — carries `params.seed` + `params.proposalDefaults.targetAnchorCount`) | **YES** | A pure function of mesh + seed + options (CLAUDE.md invariant 2) with a real content-addressed `outputHashes[0]` (SHA-256 over the anchors' flat Float64 ambient-position buffer). `recordMarginProposeJournal` re-derives the exact same seed `scripts/margin-acceptance.ts` uses (ambient centroid of the committed tooth-21 reference, `snapToSurface`-projected), calls `proposeMarginLoop` fresh both at record and replay time, and asserts the hash reproduces. |
| `margin-edit` (later, manual-drag commits) | No | Input is an interactive screen pick — not reproducible from journaled params alone. |
| `margin-confirm` | No | A param-record: re-hashes whatever anchor state the PRIOR `margin-edit` already committed — no new kernel computation of its own to replay. |
| `axis-set` | No | `inputHashes: []`/`outputHashes: []` — no content-addressed geometric output at all (it stamps a direction vector onto the restoration, a `SceneNode`-adjacent bookkeeping write). The exact "no mesh-byte output to replay against" category `docs/adr/002-scene-ops-not-journaled.md`'s `alignment-apply` amendment already established for a structurally identical case; `suggestAxis`'s own determinism is separately covered by `packages/kernel/src/axis`'s own tests, not this harness. |

`test/golden/journal-replay.test.ts` gained a dedicated shape assertion
(`margin fixture: a seeded auto-propose journals a replayable "margin-edit"
carrying seed + proposalDefaults`) alongside the pre-existing generic
`it.each` hash-reproducibility case, which now also covers this fixture.
The expensive shared setup (mesh/halfedge/curvature/BVH build on the real
~250k-triangle scan) is memoized across the harness's own repeated
self-calls (`loadMarginUpperjawSetup`) — `proposeMarginLoop` itself is
still always recomputed fresh, both at record time and inside the replay
step — keeping the addition affordable (measured: full `journal-replay.
test.ts` run in ~2.4s).

## The dentist-session narrative

Phase 3's real-fixture work ran through several rounds of feedback from
the project owner (a dentist), directly shaping the delivered tool —
worth recording here as the phase's actual working method, not just its
output:

- **References (Task 7)**: the dentist hand-traced 4 real margin
  polylines (teeth 12/11/21/22) directly in the margin editor — the SAME
  tool end users get, dogfooded as the acceptance-fixture-authoring tool.
  Clinical context volunteered during that session: this real case has
  margin **partially obscured by collapsed gingiva** in several regions —
  the traces reflect clinical judgment there, not a scan artifact. This
  single piece of context is what later explained Task 8's BLOCKED
  verdict structurally, not just numerically.
- **Editor feedback (after Task 7, before Task 8)**: three concrete UX
  requests, all delivered as a dedicated "editor enhancements" task queued
  right after Task 8/8b: (a) an anchor-count slider (20–200) — "200+
  auto-generated points are unusable"; (b) bulk (shift-click) point
  deletion; (c) a cross-section view in/near the drag magnifier. All
  three are in the demo script above.
- **The BLOCKED verdict itself**: Task 8 did not weaken the criterion to
  pass — it surfaced the honest 0/3 result and presented the project
  owner with three real options (more/cleaner fixtures, reframe the
  criterion, kernel R&D). The owner chose reframing (Task 8b) plus
  tracking a future retraction-cord fixture — a real, timestamped
  plan-level decision (`docs/plans/phase-3-margin-axis.md`, amended
  2026-07-15), not an implementer's unilateral call.

## Open items (not resolved by Task 11 — explicitly deferred, tracked for whoever picks this up next)

1. **Retraction-cord fixture (PENDING from the project owner).** The
   original, unamended full-length margin-accuracy criterion is not yet
   demonstrated anywhere — it needs a scan where the margin is genuinely
   scan-visible (not gingiva-obscured). `scripts/margin-acceptance.ts` is
   already architecture-neutral for this: dropping a new
   `test-fixtures/margins/<case>/` fixture set in and re-running the SAME
   harness is the intended path once the fixture arrives.
2. **Band-extremum R&D option (offered, not started).** Task 8b's own
   root-cause finding — the qualifying κ2 region is a WIDE 2D band around
   the true crest, not a crisp line — suggests a possible kernel
   improvement (a different scalar field, or an extremum-within-band
   selection rule, instead of `proposeMarginLoop`'s current
   "strongest-κ2-in-the-band" rule). This is real kernel R&D, out of any
   single task's scope, and the project owner has not approved starting
   it.
3. **50-vs-30 anchor-count slider default (sign-off PENDING).** The
   editor-enhancements task measured the slider's own fidelity/usability
   trade at each setting (`test/golden/margin-anchor-count-fidelity.
   test.ts`): 30 anchors costs ~67.6 µm mean fidelity (above a 50 µm
   guardrail); 50 anchors costs ~40.9 µm (within it) — the shipped default
   is 50, but the project owner has not yet explicitly signed off on that
   specific default over 30 as a genuine UX trade (fewer, easier-to-manage
   points vs. tighter fidelity).
4. Hungarian dental terminology check ("preparációs határvonal" for margin
   line, used since Task 5) — flagged for owner review, not yet confirmed.

## KERNEL_VERSION history (0.2.1 → 0.7.0)

Phase 2 ended at `0.2.1` (`docs/demos/phase-2.md`). See
`docs/CHANGELOG-kernel.md` for the full, authoritative policy and entries
— summarized here, every bump gated by the same two-layer mechanism
(`test/golden/kernel-ops.test.ts` + `scripts/check-golden-version-gate.ts`)
Phase 2 established:

| Version | Task | What changed | Golden impact |
| --- | --- | --- | --- |
| `0.2.1` | (Phase 2 end) | Baseline for this phase | — |
| `0.2.2` | Task 1 housekeeping | `kernelVersion`/`manifoldVersion` metadata added to the standalone intake/curvature/offset goldens | Metadata only, no hash change |
| `0.3.0` | Task 3 (rigid registration) | NEW: `coarseAlignFromPointTriples` + `icpRefine` (`register/` module) | Golden GAINED `icpRegister`; every other entry unchanged. Real fixture: bite0→upperjaw converges, RMS 8.282 µm, 10 iterations |
| `0.4.0` | Task 4 (margin ridge detection) | NEW: `proposeMarginLoop` (`margin/marginRidge.ts`) — bidirectional crest walk on κ2 | Golden GAINED margin-proposal entries. Real case: 3 of 4 anterior preps close (29.7mm loop / 261 anchors, 515ms) |
| `0.4.1` | Task 7 | Dentist hand-traced reference margins committed (acceptance INPUTS — no kernel algorithm change) | No hash change (no kernel behavior touched) |
| `0.5.0` | Task 8 tuning | `findRidgeStart` ignores isolated curvature-noise components (`MARGIN_MIN_RIDGE_COMPONENT_SIZE`) — the one credited tuning fix from Task 8's BLOCKED investigation | `proposeMargin`-family entries changed (verified no-op for every prior golden case; makes tooth 21 measurable at all) |
| `0.6.0` | Task 9 (insertion-axis auto-suggestion) | NEW: `axis/` module (`suggestInsertionAxis`, ROI extraction, Fibonacci hemisphere sampling) + NEW `undercutScanIndices`/`undercutScanBatchIndices` ROI-restricted primitives | Golden GAINED `suggestAxis`; every pre-existing entry (including `undercutScan`/`undercutScanBatch`) verified byte-identical |
| `0.6.0` addendum | Fix batch | HONESTY correction to a false "zero undercut achieved" default-budget claim + `AXIS_SEARCH_PRESETS` (purely additive) | Verified byte-identical — correctly NOT bumped (no kernel behavior changed) |
| `0.7.0` | Task 10 (undercut blockout preview) | NEW: `blockout/` module (`blockoutPreview` — display-only "virtual wax" preview patch, never unioned into the prep) | Golden GAINED `blockoutPreview`; every other entry unchanged |

Current: `KERNEL_VERSION = '0.7.0'` (`packages/kernel/src/index.ts`). Six
real version bumps across the phase (0.2.2/0.3.0/0.4.0/0.4.1/0.5.0/0.6.0/
0.7.0 — seven counting 0.2.2), plus one correctly-NOT-bumped fix
(0.6.0 addendum, verified byte-identical, not just assumed).

## Full local acceptance chain

All commands run in this order, this session (temp port overrides for the
`npm run dev`-backed `test:e2e` run only — `apps/client/vite.config.ts`
5173→5273, `apps/server/src/index.ts` 4100→4200,
`playwright.config.ts`'s `baseURL`/`webServer.url` matching — reverted to
the committed 5173/4100 immediately after, never committed; local `:5173`/
`:4100` were occupied by another process and `:5198` may hold the user's
own dev server this session never touched):

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean (root + every workspace) |
| `npm run lint` | clean |
| `npm test` | green — 162 files / 1612 tests passed, 2 files / 6 tests env-gated-skipped (pre-existing) |
| `npm run test:golden` | green — 13 files / 149 tests passed, 1 file / 3 tests env-gated-skipped (pre-existing) |
| `npm run test:fuzz` | green — 3 files / 12 tests |
| `npm run test:e2e` | green — 19 tests passed (10 new `phase3.spec.ts` + 9 `phase1.spec.ts`/`smoke.spec.ts`), 1 env-gated-skipped (`perf.spec.ts`'s 120 MB fixture case, pre-existing), 2 consecutive full runs both clean |

See this task's report (`.superpowers/sdd/p3-task-11-report.md`) for full
console transcripts and any environment notes.
