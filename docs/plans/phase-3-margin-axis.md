# Phase 3 — Case Setup, Margin Line, Insertion Axis: Execution Plan

Decomposition of PLAN.md Phase 3 into dispatchable tasks. Branch: `phase-3-margin-axis` (from `main` dcde2e2). Milestone M3 "Margin master".

**Phase acceptance (PLAN.md:188, AMENDED 2026-07-15 — the authoritative text lives there; summary):** auto margin proposal within 100 µm (mean) of the hand-traced reference along the ridge-VISIBLE portion for ≥ 3 preps, with per-tooth visible-coverage honestly reported (auto-proposal is a proposal, never final); the original full-length criterion is additionally demonstrated on a scan-visible (retraction-cord) fixture when supplied; margin validation rejects seeded self-intersections; undercut map on a tilted cylinder matches analytic expectation *(already pre-verified in Phase 2 Task 9: 2.3e-15 rel. error — cite, re-assert via the existing test, and add the UI-facing µm-depth heatmap this phase)*.

**Real prep data:** `arch-case-01` UpperJaw contains FOUR shoulder-prepped teeth — FDI **12, 11, 21, 22**. Four real preps satisfy "3 real prep fixtures". The project owner (a dentist) hand-traces the reference margin polylines in the margin editor (Task 7 — user-in-the-loop); references are committed as anonymized fixtures.

**Kernel primitives available (Phase 2):** curvature (H/K/κ per vertex), geodesic paths + snapPolylineGeodesic (+ incremental re-snap), surface splines (per-span locality, MarginLine adapter), undercutScan/Batch (occlusion-aware, cached BVH), signed distance/SDF, worker affinity, golden framework (KERNEL_VERSION 0.2.1 + CI gate).

## Global Constraints (bind every task)

- All Phase 2 constraints carry over verbatim: Float64 (two documented Float32 boundaries only), tests-first/analytic-first, `@errorBound`, determinism + hash tests, heavy compute in per-domain worker jobs, clinical defaults ONLY in `clinical-profiles`, golden bump+changelog discipline, layer rule, `.ts`-extension convention, meshes immutable, mm units / µm display, i18n 4 locales.
- **Commits authored solely by Zoltán Dul — NO Co-Authored-By trailer, no Claude/Anthropic attribution anywhere.**
- **Journal everything destructive**: margin create/edit ops, alignment application, axis assignment, blockout params — all append `Operation`s (PLAN §2.2); replaying must reproduce hashes (extend the replay harness where ops have kernel effects).
- Margin data lives in `CaseDocument.restorations[].marginLines` keyed by `FdiTooth` — the Task 1 type evolution defines the final shape; everything downstream uses it.
- Real-fixture UI perf: margin editing must stay interactive on the real 250k-tri upperjaw (re-snap < 100 ms/segment budget from Phase 2 holds; axis-optimization interactivity target defined in Task 9).
- Ports 5173/4100 pinned; local 5173 usually busy; a user dev server may run at :5198 — never touch it; temp overrides never committed.

---

## Task 1 — Phase 2 housekeeping + MarginLine type evolution

1. **Housekeeping ticket** (final-review bundle): (a) job-cache convention — `jobs/offset.ts` + `jobs/curvature.ts` stop rebuilding per call, `jobs/section.ts` stops re-sending buffers: unify on contentHash-keyed per-worker caches with release-listener wiring (follow jobs/bvh.ts; affinity keys where callers have them); (b) `@errorBound` placement convention — pick module-header-with-TSDoc-reference (the curvature.ts pattern), align the outliers, note in ADR-004; (c) epsilon nits: `catmullRom.ts` imports `MESH_WELD_EPSILON_MM` instead of duplicating `1e-6`; `funnel.ts` `LINE_PARALLEL_EPSILON` gets a rationale (or aligns to 1e-12 with justification); document the 1e-9 vertex-exactness band vs weld-scale deficit in `surfacePoint.ts` (derive or justify); `marchingCubes.ts` pitch floor validation (reject pitch < 1e-4 mm with typed error); (d) `kernel-workers/src/index.ts` re-exports all typed errors (SdfNotCachedError etc.); (e) `corridor.ts` string `edgeKey` → `dualEdgeKey` rename; (f) `DecimateMeshResult.mesh` branded type (`RenderOnlyMesh`) so kernel ops reject it at compile time; (g) RepairPanel bowtie-detection failure gets a visible i18n'd status line; (h) intake/curvature/offset standalone goldens gain `kernelVersion` (+`manifoldVersion` where WASM-derived) metadata fields — regenerate, version-gate-compliant (metadata-only → follow the 0.2.1 precedent: patch bump 0.2.1→0.2.2 + changelog).
2. **MarginLine shape evolution** (queued decision — RESOLVE): `shared-types` `MarginLine` becomes `{ anchors: readonly MarginAnchor[]; closed: boolean; resampledPoints?: readonly Vec3[]; }` where `MarginAnchor = { position: Vec3; triangleIndex: number; barycentric: readonly [number, number, number] }` (the SurfacePoint currency — serializable, mesh-tied via the restoration's target mesh contentHash context). `CaseDocument.schemaVersion` 1 → 2 with a documented, tested load-time migration (old `vertexAnchors`/`controlPoints` → anchors via the existing lossy adapter, journaled as a migration note); server PUT schema updated (accepts 2; rejects others; migration happens client-side on load — document). Update spline `marginLine.ts` adapters to the new shape (no more lossy nearest-vertex in the primary path).
3. Verify: full chain green; goldens per (h) with proper bump; migration round-trip test (v1 doc → load → v2 → save → reload identical).

**Verify:** `typecheck && lint && test && test:golden && test:fuzz` green. Commit.

---

## Task 2 — Case wizard: restoration setup

1. Restoration entities wired end-to-end: create/edit/delete `Restoration` in `CaseDocument.restorations` via engine CaseStore (journaled ops `restoration-create`/`-update`/`-delete` with params; no geometry hashes yet), published to zustand.
2. Wizard UI: pick restoration type (`crown | bridge` this phase — inlay/onlay greyed with i18n'd "Phase 5" note), pick teeth on a proper **FDI tooth chart** (2×16 grid, quadrant-correct numbering 11–48, per React-Odontogram-Modul conventions — visual chart, not a dropdown; multi-select for bridge: abutments + pontics marked distinctly), assign the target scan (SceneNode with role prepDie/upperJaw/lowerJaw). Bridge: teeth list validated contiguous within an arch (warning otherwise).
3. `RestorationParams` populated from `clinical-profiles` defaults (create `DEFAULT_RESTORATION_PARAMS` in clinical-profiles citing PLAN §3 table rows: cement gap 0.05, marginal gap 0.02, spacer start 0.5–1.0 → pick 0.8 documented, thicknesses per material placeholder — material profiles proper come in Phase 4; ship a `standard-zirconia` profile JSON now with schema + checksum per PLAN §3 as the first real profile, loaded/validated at startup).
4. Sidebar/case UI shows restorations (per-tooth chips, selected restoration drives later tools); persistence round-trip (restorations survive save/load — server schema already permissive, tighten to the real shape now).
5. Tests: caseStore restoration ops + journal shape; FDI chart logic (pure helpers: quadrant layout, contiguity validation) unit-tested; profile JSON schema validation test (corrupt profile → loud error); persistence round-trip; browser-lane test for the wizard's critical path; i18n parity.

**Verify:** full chain green. Commit.

---

## Task 3 — ICP registration (kernel + UI)

1. `packages/kernel/src/register/`: (a) `coarseAlignFromPointTriples(srcPts[3], dstPts[3])` — closed-form rigid transform (Horn/Kabsch on 3 correspondences), typed errors for degenerate triples (collinear/coincident, documented epsilons); (b) `icpRefine(srcMesh, dstMesh, initial, opts)` — point-to-plane ICP: sample points on src (deterministic seeded sampling, count parameterized), closest points on dst via BVH, reject outliers (distance percentile — deterministic), solve the linearized point-to-plane system (6-DOF, direct solve), iterate to convergence (relative RMS change threshold + max iterations, documented); returns `{ transform (16, column-major per SceneNode convention), rmsMm, inlierFraction, iterations, converged }`. `@errorBound`: local-minimum caveat honest (coarse init required); determinism (fixed sampling seed parameter — the CALLER passes the seed, journaled).
2. Worker job `icpRegister` (progress per iteration, cancellation).
3. UI: alignment tool — pick 3 point pairs (alternating clicks on two meshes, using the measurement pick infrastructure incl. the full-res multi-mesh candidate safety), run coarse+ICP with progress, show RMS in µm + inlier %, REQUIRE explicit user confirmation before applying (preview: ghosted overlay of the transformed mesh), apply = SceneNode transform update journaled (`alignment-apply` with transform + rms + seed params). No silent apply.
4. Tests: analytic — known rigid transform on the icosphere: coarse-from-triples recovers it exactly (machine precision); ICP from a perturbed init recovers to RMS < 1e-6 mm; noise robustness (seeded jitter → RMS ≈ noise level, documented tolerance); outlier rejection (10% far outliers → inlierFraction reflects, transform unaffected within tolerance); determinism hash (same seed → identical result); real fixture — arch-case-01 bite0 vs upperjaw: converges, RMS reported (record as golden with the standard workflow — new op entry, gate-compliant); degenerate triples rejected.

**Verify:** full chain green; real-fixture RMS reported. Commit.

---

## Task 4 — Margin ridge detection (kernel): curvature-ridge walk

The auto-proposal core. Shoulder preps (our real case) present a clear high-|κ| ledge.

1. `packages/kernel/src/margin/`: `proposeMarginLoop(mesh, curvature, seed: SurfacePoint, opts) → { anchors: SurfacePoint[], closed: boolean, confidence per-segment }` — algorithm: from the seed, locate the nearest curvature-ridge locus (max principal |κ| crest — use κ2 (most negative / concave edge of the shoulder) or |κ| ridge; EVALUATE on the real prep geometry during development and document the chosen scalar field); walk the ridge bidirectionally (steepest-crest following on the halfedge graph with geodesic step regularization — greedy crest walk with lookahead, deterministic tie-breaks), close the loop when the walk returns near the start (closure tolerance documented); simplify to spline anchors (curvature-adaptive spacing: dense on tight curves); output ready for `fitSurfaceSpline`.
2. Robustness: walk must not run away onto non-margin ridges — bounded search region around the seed (geodesic radius parameter, default from typical prep size ~10 mm, a NAMED constant in clinical-profiles if clinically meaningful — judge: it's algorithmic, keep in kernel as documented param default), confidence score per segment (ridge strength relative to neighborhood) so the UI can highlight weak segments.
3. Worker job `proposeMargin` (progress, cancellation; curvature + BVH reused via caches/affinity).
4. Tests: analytic — the standin-prep-die (truncated cone WITH a shoulder!): seed inside the prep → proposal follows the shoulder circle; assert every proposal point within a derived tolerance of the analytic shoulder circle radius/height (derive from tessellation + algorithm; report measured); a filleted-shoulder variant (generate: shoulder with small radius blend) → still tracks the crest; seeded determinism; degenerate seeds (seed on flat region far from any ridge → typed no-ridge-found error, not garbage); golden on arch-case-01 upperjaw with a FIXED seed near tooth 11's margin (hash + anchor count — becomes the regression pin for the real case; version-gate workflow).

**Verify:** full chain green; measured prep-die tracking error reported. Commit.

---

## Task 5 — Margin editor UI

1. Margin tool (per selected restoration + tooth): **auto-propose** (click inside the prep → worker `proposeMargin` → result fitted via `fitSurfaceSpline` closed → rendered as editable overlay: spline curve + anchor handles; weak-confidence segments visually flagged); **manual mode** from scratch (click sequence places anchors, geodesic-snapped).
2. Editing: drag anchor (live re-snap via `resnapPolylineAnchor` locality + spline local re-fit — must stay < 100 ms per edit on the real upperjaw, measure), add anchor on segment (click), delete anchor, close/open toggle. **Magnifier widget** around the cursor during margin editing (small secondary viewport patch or zoom lens — implementer picks the cheap correct approach; document).
3. Every completed edit gesture journals ONE coalesced op (`margin-edit`, params: tooth, anchor diff, resulting hash) — no per-mousemove spam; margin stored in the restoration's `marginLines[tooth]` (Task 1 shape); persistence round-trip.
4. Rendering: margin curve as a polyline overlay re-centered like measurement overlays; distinct colors for proposed vs confirmed; anchors as screen-space handles.
5. Tests: engine margin-tool state machine (pure logic: gesture → anchor ops) unit tests; re-snap latency measured on real fixture (report); journal coalescing test; browser-lane test (propose on the standin die via UI path, drag an anchor, assert store state); i18n parity.

**Verify:** full chain green; edit latency reported. Manual dev-server check on arch-case-01 tooth 11 described (temp port; do NOT touch :5198). Commit.

---

## Task 6 — Margin validation

1. `packages/kernel/src/margin/validate.ts`: `validateMarginLine(mesh, margin) → { closed, selfIntersecting (on-surface polyline segment-pair test — geodesic-domain aware: ambient segment intersection with on-surface tolerance, documented), onSurface (every resampled point ≤ weld ε via BVH), smoothnessWarnings (curvature-of-the-curve outliers: discrete curve curvature > threshold flagged with locations), degenerate (too few anchors, zero length) }` — deterministic, typed result (not exceptions — validation REPORTS; gating decides elsewhere).
2. Wire into the editor: live validation badge (valid / warnings / invalid with i18n'd reasons); a margin with hard failures (open, self-intersecting, off-surface) cannot be "confirmed" on the restoration (soft-block with explicit acknowledge path per CLAUDE.md gate semantics — acknowledged warnings journaled).
3. Tests: **ACCEPTANCE — seeded self-intersection rejection: construct margins with deliberate self-intersections (figure-eight anchor sets on the prep die + on arch-case-01) → selfIntersecting true, editor blocks confirm**; closed/open detection; off-surface detection (tampered point); smoothness warning triggers on a deliberate zigzag; clean margins pass; determinism.

**Verify:** full chain green; acceptance assertion cited in report. Commit.

---

## Task 7 — Hand-traced reference margins (USER-IN-THE-LOOP)

The dentist project owner traces the reference margins used by Task 8's acceptance test.

1. Dev-only export path: a button/command in the margin editor (dev panel) exporting the confirmed margin for the current tooth as anonymized JSON (`{ tooth, anchors, resampled polyline, meshContentHash, traced: 'human-reference' }`) into `test-fixtures/margins/arch-case-01/<tooth>.reference.json` (schema documented; no PHI — contentHash ties it to the anonymized fixture).
2. **Controller/user step (NOT a subagent step):** the user traces margins for FDI 12, 11, 21, 22 on arch-case-01 UpperJaw in the running app (manual editing from Task 5; auto-propose may be used as a starting point but the FINAL trace is human-adjusted — that's what makes it a reference). Export all four; commit as fixtures (LFS not needed — small JSON).
3. Reference-quality checks (automated, run on the committed files): each reference passes Task 6 validation (closed, non-self-intersecting, on-surface); resampled at the standard density; per-tooth circumference within anatomical sanity bounds (upper incisors: ~15–35 mm — loose sanity, not clinical dogma; document).
4. Golden integrity: sha256 of the reference files pinned (fixture-integrity test like other fixtures).

**Verify:** four committed reference files, validation green. Commit. *(This task PAUSES for the user's tracing session — the controller coordinates timing with the user.)*

---

## Task 8 — Auto-proposal acceptance  *(acceptance-critical: ≤100 µm mean, ≥90% length, ≥3 real preps)*

1. Comparison harness: `scripts/margin-acceptance.ts` + `test/golden/margin-acceptance.test.ts` — for each reference (12, 11, 21, 22): run `proposeMargin` with a deterministic seed derived from the reference (e.g. centroid-interior point — documented, journal-style params), resample both curves at matched arc-length density, compute pointwise geodesic-free distance (closest-point distance from proposal to reference polyline — document the metric honestly: ambient closest-point on the resampled reference), report per-tooth: mean deviation over the length, fraction of length within 100 µm, max deviation.
2. **ACCEPTANCE ASSERTION: on ≥3 of the 4 teeth, mean ≤ 0.100 mm for ≥90% of the proposal length. REPORT all measured numbers per tooth.** If the detector misses on the real case, tune Task 4's parameters (documented, journaled defaults) — tuning is legitimate; weakening the assertion is not. If genuinely unreachable, BLOCKED with the numbers and analysis.
3. The acceptance runs in the default golden lane if fast (<10 s) else env-gated into perf-guard with a fast smoke subset default (follow the established pattern; document).
4. docs update: measured table into the phase evidence doc draft.

**Verify:** acceptance green with reported numbers. Commit.

---

## Task 9 — Insertion axis tool

1. `packages/kernel/src/axis/`: `suggestInsertionAxis(mesh, region, opts)` — hemisphere direction sampling (deterministic spiral/Fibonacci set, count parameterized) scored by undercutScanBatch restricted to the restoration's region (**ROI**: triangles within a geodesic/euclidean radius of the margin loop(s) — region extraction utility; kernel data never decimated, ROI is an index subset); score = undercut area (weighted by depth — document the objective); coarse→fine refinement around the best direction (local neighborhood sampling); returns ranked axes + per-direction stats. Bridges: one common axis over the union of abutment regions + per-abutment undercut report (PLAN).
2. Worker job with progress per batch; interactivity target: suggestion on the real upperjaw ROI < 2 s (measure, report; ROI should make this easy vs the 0.5–1 s full-mesh extrapolation).
3. UI: axis tool per restoration — auto-suggest (arrow gizmo showing the axis), manual adjust (drag gizmo / two angle sliders like the section tool), **live undercut µm-depth heatmap** on the prep region while adjusting (undercutScan per adjustment, vertex colors via the existing path — per-triangle depth mapped to vertices documented; throttled to keep interaction fluid, measured), per-abutment readout for bridges; axis stored on the restoration (`insertionAxis`), journaled (`axis-set` op).
4. Tests: analytic — tilted-cylinder acceptance re-cited (existing P2 test) + axis SUGGESTION on the tilted cylinder returns the cylinder axis within angular tolerance (derive); prep-die: suggested axis within tolerance of the die's construction axis; sphere (no undercut anywhere): any axis scores equal → deterministic tie-break documented; ROI extraction unit tests (region correctness on fixtures); bridge two-region case (two dies fixture — generate); determinism; golden on arch-case-01 (fixed margin → fixed suggestion; version-gate workflow); UI store tests + browser-lane test for the axis panel.

**Verify:** full chain green; suggestion timing + angular accuracies reported. Commit.

---

## Task 10 — Undercut blockout preview (virtual wax)

1. `packages/kernel/src/blockout/`: `blockoutPreview(mesh, region, axis, thresholdMm)` — for the prep region w.r.t. the chosen axis: identify undercut triangles (threshold from clinical profile: "Undercut blockout threshold 0 µm" PLAN §3 — goes into clinical-profiles), compute the blocked-out surface: sweep undercut region vertices along the axis to the visibility horizon (per-vertex blockout displacement = depth needed to remove the undercut — reuse undercut depth machinery; document the exact construction + `@errorBound`), output a preview mesh (display-only this phase — the REAL blockout solid is Phase 4 inner-surface work; document the scope boundary explicitly).
2. Worker job; UI: blockout preview toggle in the axis tool (ghosted wax-colored overlay), parameter readout; preview params journaled when the axis is confirmed (`axis-set` op gains blockout params).
3. Tests: analytic — tilted cylinder: blockout displacement matches the closed-form undercut depth profile (derive); prep-die with tilted axis: blocked-out preview eliminates undercut (re-scan the preview mesh → zero undercut w.r.t. the axis within tolerance — the self-consistency test); no-undercut case → empty preview; determinism; golden.

**Verify:** full chain green; self-consistency numbers reported. Commit.

---

## Task 11 — Phase 3 e2e, docs, acceptance wrap-up

1. e2e (`e2e/phase3.spec.ts`): open arch-case-01 → wizard: crown on tooth 11 → auto-propose margin (seed via test hook) → edit one anchor → validation badge valid → confirm → axis suggest → undercut heatmap visible (store-level assertion) → save → reload → margin + axis restored. Deterministic waits; store test hooks pattern from Phase 1/2.
2. Journal replay extension: margin/axis/alignment ops enter the replay harness (kernel-effect ops replayed, hashes identical).
3. `docs/demos/phase-3.md`: acceptance evidence (per-tooth margin numbers from Task 8, seeded-self-intersection rejection, tilted-cylinder citation + axis-suggestion accuracies), demo script, KERNEL_VERSION history delta.
4. Full local acceptance chain green (all suites + e2e; temp ports; never touch :5198).

**Verify:** all green; docs complete. Commit.
