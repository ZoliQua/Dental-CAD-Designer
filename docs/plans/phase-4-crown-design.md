# Phase 4 — Crown Design: Execution Plan

Decomposition of PLAN.md Phase 4 into dispatchable tasks. Branch: `phase-4-crown-design` (from `main` abb2683). Milestone M4 "First crown".

**Phase acceptance (PLAN.md):** end-to-end crown on a fixture prep passes ALL QC gates; margin fit — max gap between crown margin and margin spline ≤ 10 µm; simulated seating (boolean crown ∩ prep die) shows zero penetration beyond configured interference; thickness gate blocks a deliberately thin design; full redesign reproducible from journal (identical hashes).

**Real data:** `arch-case-01` UpperJaw has 4 shoulder preps (FDI 12/11/21/22) with committed hand-traced reference margins (validate clean, closed); LowerJaw = antagonist; TotalJaw0/1 = bite scans. This supports the FULL pipeline (prep + margin + antagonist + neighbors). The margin-accuracy auto-detection certification is separately TRACKED-PENDING (needs a scan-visible retraction-cord fixture) — Phase 4 uses the hand-traced/confirmed margins as pipeline INPUT, so it is unaffected. Tooth 11's margin never auto-closes; use a hand-traced margin as the primary fixture input.

**The crown pipeline (6 fixed-order stages, each journaled):** inner surface → anatomy placement → adaptation/morphing → shell construction → freeform → QC. Lives in `packages/cad-pipeline/` (restoration stages + QC gates) per the repo map.

## Global Constraints (bind every task)

- All Phase 2/3 constraints carry over: Float64 (documented Float32 boundaries only), tests-first/analytic-first, `@errorBound`, determinism + hash tests, heavy compute in per-domain worker jobs, **clinical defaults ONLY in `clinical-profiles`** (this phase reads MANY: gaps, thicknesses, contact targets, connector areas — all from the material profile, never hardcoded), golden bump+changelog discipline (KERNEL_VERSION currently 0.7.1), layer rule (`cad-pipeline → kernel, io, shared-types`), `.ts`-extension convention where node-worker-reachable, meshes immutable, mm units / µm display, i18n 4 locales.
- **Commits authored solely by Zoltán Dul — NO Co-Authored-By trailer, no Claude/Anthropic attribution anywhere.**
- **Journal every stage** (PLAN §2.2 + the fixed-order requirement): each pipeline stage appends an `Operation` with input/output hashes; **replaying the journal reproduces every stage hash bit-identically** (acceptance criterion — extend the replay harness with the stage ops; this is the hardest determinism bar in the project so far — RBF solves, boolean cleanup, and brush strokes must ALL be deterministic).
- **QC gates block export, never silently bypassed** (CLAUDE.md invariant 4): gates may be *acknowledged with a journaled warning*, never weakened to pass. **Never weaken a gate threshold to make a test green.**
- **Dual validation stays dual** (invariant 6): the server re-validates the exported crown independently — Phase 4 lays the groundwork; full export is Phase 7, but the QC gates must be callable from BOTH client-worker and Node-server contexts.
- **Booleans go through the manifold-3d wrapper** (`kernel/src/boolean/`); watertight in, re-validated out; the shell-construction boolean is the most failure-prone op — repair-before-boolean, never bypass.
- Ports 5173/4100 pinned; local 5173 usually busy; a user dev server may run at :5198 — never touch it; temp overrides never committed.

## Phase 3 carry-ins (fold into Task 1)

- **Chord-cap for margin-fit:** the ≤10 µm margin-fit gate must consume the margin's dense `resampledPoints`/spline, NEVER anchor chords (localized ~220-290 µm anchor-chord deviation would falsely fail the gate).
- **Die-offset perf (from P2):** offset of a die-sized region at clinical 0.02 mm pitch took 117-126 s (bbox-conservative band marking on coarse tessellation). The inner-surface stage offsets die-scale regions — this MUST be improved (ROI-tight band; the axis ROI machinery is the model) or the design loop is unusable. Measure + report.
- **Composite-interaction blockout gap:** Phase 3's display-only blockout preview did not account for the wax bulge occluding outside-region triangles. Phase 4's REAL (solid) blockout in the inner surface must handle this correctly (self-consistency: the blocked-out inner surface re-scanned along the insertion axis has zero undercut).
- **Duplicated per-worker caches** (curvature 2×, halfedge 4×): consolidate before Phase 4's new job families multiply them further.

---

## Task 1 — cad-pipeline scaffold, QC types, margin-band primitive, Phase 3 carry-ins

1. **cad-pipeline package**: real structure `packages/cad-pipeline/src/{stages,gates,pipeline}/`; `RestorationStageResult` types; a `PipelineContext` (mesh store handles, material profile, insertion axis, margin, antagonist — the shared inputs stages consume); layer-rule wiring (imports kernel/io/shared-types only; lint-enforced). Pure functions returning new meshes/hashes.
2. **QC types + gate infrastructure**: `QcGateResult`/`QcReport` already in shared-types — build the gate RUNNER (`runQcGates(context, gates[]) → QcReport`), each gate a pure `(context) → QcGateResult` with `{ gate, passed, acknowledged, value, threshold, unit, message }`. Gate registry; deterministic ordering; the runner is callable from client-worker AND Node (dual-validation prerequisite — no DOM/Three deps).
3. **Margin-band primitive**: `packages/kernel/src/margin/band.ts` — from a confirmed MarginLine (dense on-surface loop) build the geometric structures downstream stages need: the ordered loop as a Float64 polyline, the loop's local frame/normal, and a `marginLoopMesh` helper (the loop as a degenerate-thin ring for boolean stitching). The chord-cap fix lives here (consume resampledPoints).
4. **Phase 3 carry-ins**: die-offset ROI-band perf fix (measure die-scale offset before/after — target < 10 s at 0.02 mm pitch, report honestly); per-worker cache consolidation (shared cache module for curvature/halfedge/bvh keyed by contentHash — the margin/axis/blockout/geodesic/curvature jobs share it); document.
5. Material profile extension: the standard-zirconia profile (Phase 3) gains the full Phase-4 parameter set from PLAN §3 (cement gap 0.05, marginal gap 0.02, spacer start 0.8, min wall 0.5, proximal +0.02, occlusal 0, max chord deviation 0.005) — schema + checksum bump; a `emax-lithium-disilicate` profile added (wall 1.0 occlusal / 0.8 axial per PLAN) so thickness gates are material-aware. Loud validation.
6. Tests: gate-runner unit tests (a trivial always-pass + always-fail gate; acknowledge path journaled); margin-band analytic (a circular margin → band frame correct); cache-consolidation determinism (shared cache returns byte-identical results); die-offset perf test (report); profile schema + checksum tests; determinism.

**Verify:** full chain green; die-offset perf reported. Commit.

---

## Task 2 — Tooth library (format, starter assets, backend, loader)

1. **Library format** (documented for third-party import per PLAN): `packages/tooth-library/` — a versioned tooth asset = watertight anatomical mesh (STL/PLY bytes, content-addressed) + metadata (FDI number, landmark points [cusp tips, central fossa, marginal ridges, contact areas], a canonical local frame [mesial-distal / bucco-lingual / occluso-gingival axes], morph-target deltas for cusp height/width). Schema + checksum; version field.
2. **Starter asset set**: an openly-licensed OR procedurally-generated anatomical set for the teeth Phase 4 needs FIRST (the 4 upper incisors 12/11/21/22 for the real case + at least one posterior for later). If no openly-licensed set is available offline, PROCEDURALLY generate plausible anatomical crowns (documented as placeholder-anatomy, provenance clear, replaceable — PLAN §9 licensing risk mitigation) — a parametric incisor (incisal edge, cingulum, marginal ridges) + parametric molar (4 cusps, central fossa). Landmarks + frame computed/authored. Deterministic generation.
3. **Backend**: tooth-library assets stored content-addressed (reuse the mesh-storage pattern from P1 Task 11); routes `GET /api/tooth-library` (list versions), `GET /api/tooth-library/:fdi` (asset + metadata). JSON-schema'd; immutable.
4. **Loader** (`packages/tooth-library/src/loader.ts`): load asset by FDI, validate checksum, expose mesh + landmarks + frame + morph targets to the anatomy stage.
5. Tests: format schema validation + checksum tamper; procedural generator determinism (same → byte-identical); landmark/frame correctness (analytic: an incisor's incisal edge landmark is the most-occlusal point); loader round-trip; backend routes via inject; library versioning.

**Verify:** full chain green. Commit.

---

## Task 3 — Inner surface stage: offset zones + smooth blend

The cement-gap geometry — clinically the crown's fit surface.

1. `packages/cad-pipeline/src/stages/innerSurface.ts` — from the prep region (mesh area inside the margin loop — region extraction via the margin band + geodesic/flood interior) build the offset inner surface: **two zones with a smooth blend** — marginal-gap offset (0.02 mm from profile) in a band near the margin up to the spacer-start line (0.8 mm above margin along the surface), cement-gap offset (0.05 mm) above the spacer line; C1 smooth blend between zones (documented blend function + width; no step). Offset via the SDF→MC machinery (Task 7 of P2) restricted to the prep ROI (die-offset perf fix from T1 applies).
2. `@errorBound`: offset error (pitch/2 chain) + blend approximation; the RESULT carries the bound for the margin-fit QC gate.
3. Worker job `innerSurfaceOffset` (progress across SDF/MC/blend; cancellation; ROI+cache reuse).
4. Both the marginal and cement gaps are REQUIRED params from the profile (no kernel defaults).
5. Tests: analytic — a truncated-cone prep-die (the P3 standin has a shoulder): inner surface offset by the two gaps has measured radial offset matching the zone (marginal band = 0.02 within bound, cement zone = 0.05 within bound, REPORT measured); blend region monotonic C1 (no step > documented tolerance); determinism; golden on standin-prep-die + arch-case-01 tooth-11 region (KERNEL_VERSION bump workflow — new op); the offset preserves margin detail at 0.02 mm pitch (margin ridge not destroyed — measure).

**Verify:** full chain green; measured offsets + perf reported. Commit.

---

## Task 4 — Inner surface stage: undercut blockout + skirt-to-margin  *(acceptance-critical: margin fit ≤ 10 µm)*

1. **Real solid blockout**: the inner surface's undercut regions (relative to the insertion axis) are blocked out so the crown seats — extend the offset inner surface so no undercut remains along the axis. Reuse the axis/undercut/blockout machinery, but produce a SOLID-consistent inner surface (the composite-interaction gap from P3 MUST be handled: re-scan the blocked-out inner surface along the axis → zero undercut, self-consistency test).
2. **Skirt to margin (exact adaptation)**: the inner surface boundary must coincide EXACTLY with the margin spline — a skirt transitions from the offset inner surface down to the margin loop where the gap goes to ZERO at the margin (marginal seal). The boundary of the inner surface == the margin polyline within the acceptance tolerance.
3. **ACCEPTANCE PART — margin fit ≤ 10 µm**: `marginFitGate` (in cad-pipeline gates) measures the max distance between the inner-surface margin boundary and the margin spline (dense resampledPoints — chord-cap fix) → must be ≤ 0.010 mm. REPORT measured max on the standin-prep-die AND arch-case-01 tooth-11. This is a phase acceptance criterion — do not weaken; if unreachable, BLOCKED with numbers + analysis.
4. Worker job extension; the full inner-surface stage (offset+blend+blockout+skirt) journaled as one stage op.
5. Tests: **margin-fit ≤ 10 µm asserted + measured on both fixtures**; self-consistency (blocked-out inner surface re-scanned → zero undercut within tolerance); skirt continuity (no gap/overlap at the margin); seating pre-check (inner surface ∩ prep die along axis → no penetration beyond marginal seal); determinism; golden.

**Verify:** full chain green; margin-fit + self-consistency numbers reported (acceptance evidence). Commit.

---

## Task 5 — Anatomy placement stage

1. `packages/cad-pipeline/src/stages/anatomyPlacement.ts` — load the library tooth for the restoration's FDI (Task 2 loader); auto-place: align the tooth's canonical frame to the case (occlusal plane from the antagonist/arch; mesial-distal from neighbor bounding boxes; occluso-gingival from the margin plane + insertion axis); scale to the mesial-distal + occluso-gingival space between neighbors and antagonist. Returns the placed (transformed) library mesh + the transform (journaled).
2. Manual transform API (position/rotation/scale + anatomical handles — the handles map to landmark points); deterministic auto-placement.
3. Worker job `placeAnatomy` (fast — a transform solve, not heavy geometry).
4. Tests: analytic — a synthetic neighbor-pair + occlusal plane → placed tooth frame aligned within tolerance (derive); scale fills the inter-neighbor space; determinism; the real case (tooth 11 with 12/21 as neighbors, lower jaw antagonist) → placement plausible (landmarks in anatomically sane positions — bounded); golden.

**Verify:** full chain green. Commit.

---

## Task 6 — Adaptation / morphing stage

The clinically hardest geometry — deform the library tooth to the patient.

1. `packages/cad-pipeline/src/stages/morphing.ts` — RBF (or cage) deformation of the placed library tooth to satisfy: (a) proximal contacts at target penetration (+0.02 mm from profile) against neighbors; (b) antagonist contact at target occlusal contact (0 mm from profile) against the lower jaw; (c) blend the cervical region to the margin/inner-surface boundary. Deformation = solve RBF weights from constraint points (contact targets + margin anchors as fixed), apply to the tooth surface. DETERMINISTIC solve (direct, documented — no iterative-tolerance nondeterminism; the journal-reproducibility bar).
2. **Contact heatmaps**: proximal + occlusal contact/clearance as µm distance heatmaps (reuse the P1 surface-distance heatmap); the sliders (contact strength) re-run the RBF solve — interactivity target (< 500 ms per adjustment on the real tooth, measure).
3. `@errorBound`: RBF is an approximation to the target contacts — the RESIDUAL contact error (achieved vs target penetration) is measured + reported (a QC-relevant number; the contact gates consume it).
4. Worker job `morphAnatomy` (progress, cancellation).
5. Tests: analytic — two synthetic neighbors at known positions + a library tooth: after morphing, the proximal contact penetration = target +0.02 mm within documented residual (REPORT); antagonist contact = 0 within residual; cervical blends to margin (continuous); determinism (same constraints → byte-identical); RBF property (morph(0-strength) ≈ identity); the real case morph completes < 5 s (report); golden.

**Verify:** full chain green; contact residuals + timing reported. Commit.

---

## Task 7 — Shell construction stage + thickness gate

1. `packages/cad-pipeline/src/stages/shell.ts` — combine outer anatomy (morphed tooth) + inner surface + margin band into a SINGLE WATERTIGHT SOLID via the manifold-3d wrapper (boolean/stitch: the outer and inner surfaces joined at the margin band into a closed shell). Repair-before-boolean (intake); re-validate output watertight + manifold + self-intersection-free (the wrapper enforces). The margin band is the seam.
2. **Thickness gate + auto-thicken**: `minWallThicknessGate` — measure minimum wall thickness (inner-to-outer distance via BVH/SDF across the shell) against the material profile minimum (0.5 mm zirconia); heatmap of thickness; `autoThicken` option (bounded outward displacement of thin regions, re-checked, journaled) — never silently thin; auto-thicken is user-invoked + journaled.
3. Worker job `constructShell` (progress across boolean/thickness; cancellation).
4. Tests: analytic — a simple prep + placed anatomy → shell is watertight + manifold (analyzeMesh + manifold status asserted); thickness measured correctly (a known-thin synthetic region flagged); auto-thicken raises the thin region above minimum (re-measured); thickness gate BLOCKS a deliberately-thin design (acceptance element); determinism; boolean determinism (same inputs → same shell hash — the WASM boundary is the risk; pin + document); golden.

**Verify:** full chain green. Commit.

---

## Task 8 — Freeform sculpting brushes

1. `packages/cad-pipeline/src/stages/sculpt.ts` — add/remove/smooth brushes: volume-aware displacement with symmetric radial falloff along the surface normal, applied to the OUTER surface only unless explicitly unlocked (inner/margin locked by default — protects the fit surface). Each brush stroke is a deterministic operation (documented falloff; a stroke = center + radius + strength + brush type → deterministic vertex displacement).
2. **Stroke journaling (coalesced)**: every stroke journals an `Operation` (coalesced per gesture — no per-mousemove spam, like margin-edit); replaying strokes reproduces the sculpted mesh bit-identically (the determinism bar — brush math must be exact).
3. Worker job `applySculptStroke` (fast, interactive — < 50 ms per stroke on the real shell, measure); after sculpting the shell re-validates (still watertight — a brush can't tear the mesh; document the safe-displacement bound).
4. Tests: brush determinism (same stroke → byte-identical); add/remove/smooth each correct on a synthetic surface (add raises, remove lowers, smooth reduces curvature); inner/margin lock enforced (a stroke near the margin doesn't move locked vertices — the ≤10µm fit preserved after sculpting!); stroke replay reproduces the mesh; watertight preserved; timing.

**Verify:** full chain green; margin-fit preserved-after-sculpt asserted. Commit.

---

## Task 9 — QC gate suite  *(acceptance-critical: all gates + seating + thickness-blocks-thin)*

The full §6 gate run. Some gates exist (margin-fit T4, thickness T7); this task completes + integrates them.

1. Complete the gate set in `packages/cad-pipeline/src/gates/`: watertight, manifold, no-self-intersection (via manifold status), min-wall-thickness (T7), margin-fit-deviation (T4, ≤10µm), **seating-penetration** (boolean crown ∩ prep die along insertion axis → zero penetration beyond the configured interference — acceptance element; measure penetration, gate on profile interference), connector-cross-section (bridge — stub for Phase 6, documented), occlusal/proximal-contact (achieved vs target from morphing residuals). Each gate: pure, deterministic, material-profile-parameterized, journaled result.
2. `runQcGates` produces the full `QcReport` stored on the restoration (`qc` field); gates acknowledgeable-with-warning (journaled), never silently bypassed; a hard-failed gate blocks the "design complete" state.
3. **Seating simulation**: `seatingGate` — boolean intersection of the crown shell with the prep die swept along the insertion axis; any material of the die inside the crown beyond the marginal seal / configured interference = penetration; report max penetration.
4. Worker job `runQc` (progress per gate, cancellation).
5. Tests: **ACCEPTANCE — end-to-end crown on the standin-prep-die (+ arch-case-01 tooth-11) → ALL gates pass; margin-fit ≤ 10 µm; seating penetration zero beyond interference; a deliberately-thin crown → thickness gate FAILS (blocks)**; each gate unit-tested with a passing + failing fixture; acknowledge-path journaled; determinism (QcReport hash-stable); golden.

**Verify:** full chain green; the acceptance assertions cited + measured. Commit.

---

## Task 10 — Crown design UI (staged workflow)

1. Crown design tool (per crown restoration): a staged workflow panel driving the 6 stages in fixed order — inner surface (auto, shows the offset), anatomy placement (library pick + auto-place + manual transform gizmo), morphing (contact heatmaps + strength sliders re-running the RBF), shell (construct + thickness heatmap + auto-thicken button), freeform (brush palette: add/remove/smooth, radius/strength, outer-only lock indicator), QC (run gates → QcReport display with per-gate pass/fail/acknowledge). Each completed stage journals; the workflow enforces order (can't shell before anatomy).
2. Rendering: stage-appropriate overlays (inner surface ghosted, contact heatmaps, thickness heatmap, QC gate highlights on failing regions); the design mesh in the viewer.
3. Full journaling: every stage + sub-action (transform, slider commit, brush stroke, auto-thicken, gate acknowledge) as coalesced ops; the restoration's `stages` hashes updated.
4. Tests: workflow state machine (stage order enforced; pure logic node-lane); browser-lane critical path (inner→anatomy→morph→shell→QC on a small fixture via UI, assert store + journal); contact-slider re-run; i18n parity 4 locales.

**Verify:** full chain green; manual dev-server check on arch-case-01 tooth-11 crown described (temp port, NOT :5198). Commit.

---

## Task 11 — Server: dual-validation groundwork + tooth-library management

1. **Dual-validation prerequisite**: the QC gate runner (T1/T9) runs in the Node server context (no DOM/Three) — a `POST /api/restorations/:id/validate-qc` route that takes the crown mesh + context and re-runs `runQcGates` independently, returning a server-side QcReport; the client/server QcReports must AGREE (bit-identical gate values) — a mismatch = hard error (the dual-validation invariant; full export is Phase 7, this proves the gates are context-portable). JSON-schema'd.
2. Tooth-library management (extends T2 routes): admin upload of a library asset (content-addressed, versioned, schema+checksum validated server-side); the anatomy stage fetches from here.
3. Crown persistence: the restoration's `stages` (mesh hashes) + `qc` (QcReport) survive save/load; the design meshes stored content-addressed (P1 mesh-storage); journal replay of the crown stages reproduces hashes server-side (the reproducibility invariant, server-checked).
4. Tests: server QC re-validation matches client (same fixture → identical QcReport via inject); tooth-library upload/fetch round-trip; crown persistence round-trip (stages + qc restored); journal replay server-side (crown stage ops → identical hashes); schema validation.

**Verify:** full chain green; client/server QC agreement asserted. Commit.

---

## Task 12 — End-to-end acceptance + journal reproducibility  *(the phase gate)*

1. **Full acceptance harness** (`test/golden/crown-acceptance.test.ts` + script): on the standin-prep-die AND arch-case-01 tooth-11 (hand-traced margin input), run the COMPLETE pipeline (inner → anatomy → morph → shell → QC) with fixed params/seeds → assert ALL of: every QC gate passes; margin-fit ≤ 10 µm (measured, reported); seating penetration zero beyond interference (measured); a deliberately-thin variant → thickness gate blocks; **full redesign from the journal reproduces every stage hash bit-identically** (record the journal, replay fresh, assert identical stage hashes — the hardest determinism bar; RBF + boolean + brushes all deterministic).
2. Runtime: the full pipeline on the real tooth — end-to-end time reported (design-loop usability signal); env-gate the heavy real-case run if > ~30 s, keep a fast synthetic in the default lane.
3. **Journal-replay harness extension**: the crown stage ops (inner-surface, anatomy-place, morph, shell, sculpt, qc) enter the replay harness with content-addressed outputs.
4. If any acceptance element fails, tune/fix per the rules (never weaken gates); if genuinely unreachable, BLOCKED with full numbers + analysis (like T8's honest verdict).

**Verify:** all acceptance assertions green with measured numbers reported; journal reproducibility proven. Commit.

---

## Task 13 — e2e, docs, phase wrap-up

1. e2e (`e2e/phase4.spec.ts`): open arch-case-01 → existing margin+axis on tooth 11 → crown design: inner surface → anatomy (pick library tooth) → morph (adjust a contact slider) → shell (construct, thickness heatmap) → freeform (one brush stroke) → QC (run gates, all pass badge) → save → reload → crown restored (stages + QcReport). Deterministic waits; test hooks; store-level assertions for GPU-dependent bits.
2. `docs/demos/phase-4.md`: acceptance evidence table (all gates + margin-fit + seating + thickness-block + journal-reproducibility, measured numbers, test names), demo script (the staged crown workflow), KERNEL_VERSION history delta, the tooth-library provenance note (placeholder-anatomy if procedural), open items.
3. ADR if warranted (e.g. RBF determinism approach; tooth-library format; the staged-pipeline architecture).
4. Full local acceptance chain green (all suites + e2e; temp ports; never touch :5198).

**Verify:** all green; docs complete. Commit.
