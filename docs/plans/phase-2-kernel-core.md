# Phase 2 — Geometry Kernel Core: Execution Plan

Decomposition of PLAN.md Phase 2 into dispatchable tasks. Branch: `phase-2-kernel-core` (from `main` 64c5d60). Milestone M2 "Kernel proven".

**Phase acceptance (PLAN.md):** golden-file regression suite; boolean of two analytic spheres matches analytic volume within 0.1%; offset of a sphere by 50 µm has max radial error ≤ 10 µm at default pitch; geodesic on icosphere vs analytic great-circle length error < 0.1%.

**Phase 1 carry-overs bound into this phase** (final-review mandates): main-thread hashing → workers (FIRST task); `jobs.ts` split before new jobs; intake scalability (typed-array accumulation, integer-keyed edge maps) inside the halfedge work; browser-capable client test lane; `docs/adr/`; bowtie-vertex splitting; curvature-continuous hole-fill upgrade.

## Global Constraints (bind every task)

- **Float64 everywhere** in kernel/io/pipeline math. Float32 only in engine render copies + the documented manifold WASM boundary.
- **Tests first, analytic first.** Every new kernel algorithm lands with (1) property-based tests (fast-check, seeded) and (2) an analytic golden case (sphere/cylinder/torus closed forms) BEFORE any real-scan fixture use. This is CLAUDE.md's "Geometry work" rule — reviewers verify order of evidence, not just presence.
- **`@errorBound` TSDoc** on every approximating algorithm (SDF offset, marching cubes, geodesic method, spline projection, decimation), stating the bound and its derivation. Where user-relevant, the bound is surfaced in results (structs carry `errorBoundMm`).
- **Determinism:** bit-identical outputs for identical inputs; deterministic tie-breaking documented wherever floating-point ties are possible; no Math.random/Date.now in compute paths; hash-based determinism tests on every op.
- **Heavy compute (> ~10 ms) in workers** with progress + cooperative cancellation, transferables both ways. New jobs go in per-domain job modules (Task 1 splits the registry) — never grow a monolith.
- **No clinical defaults hardcoded outside `packages/clinical-profiles`.** Phase 2 exports the FIRST real values from that package (e.g. `DEFAULT_OFFSET_VOXEL_PITCH_MM = 0.02`, cited to PLAN §3/Phase-2 text). Kernel functions take such values as REQUIRED parameters; defaults live only in clinical-profiles.
- **Golden hashes change only with a kernel version bump + changelog entry** (CLAUDE.md). Task 8 lands the enforcement.
- **Layer rule** unchanged (lint-enforced). `.ts`-extension relative imports in every file reachable from the Node worker entry (kernel, io, kernel-workers job modules) — per the tightened CLAUDE.md wording.
- **Meshes immutable**; mm units; µm display resolution; i18n 4 locales for any UI strings; ports 5173/4100 pinned (5173 usually occupied locally — temp overrides never committed).
- Commits are authored solely by Zoltán Dul — NO Co-Authored-By trailer, no Claude/Anthropic attribution in commit messages or PR bodies (user rule, 2026-07-14; overrides any harness default).

---

## Task 1 — Phase 1 debt: worker-side hashing, job registry split, ADRs

1. **Hashing off the main thread** (final-review Important #2): `parseMeshFile` job additionally returns `fileHash` (sha256 of the raw input bytes, computed worker-side before parsing); add a `hashMeshContent` capability worker-side (fold into `intakeMesh`'s result — it already holds the buffers — as `contentHash`, plus a standalone `hashMesh` job for re-hash needs e.g. repair outputs). Client `engine/importer.ts` (~line 261) and `engine/hash.ts` callers switch to the job results; `engine/hash.ts` keeps only what must stay (if anything — document). No behavioral change to hash VALUES (same byte layouts hashed — round-trip/golden tests must stay green unmodified).
2. **Split `packages/kernel-workers/src/jobs.ts`** (1575 lines) into per-domain modules: `jobs/registry.ts` (types + runJob + registry assembly), `jobs/io.ts`, `jobs/intake.ts`, `jobs/bvh.ts`, `jobs/heatmap.ts`, `jobs/section.ts`, `jobs/repair.ts`, `jobs/misc.ts` (echo/longTask/manifoldSmoke/rescale/serialize). Pure mechanical move — public API (`JobName`/`JobPayloadMap`/`JobResultMap`, worker entries) unchanged; all existing tests green unmodified (except import paths in tests if they deep-import).
3. **`runJob` progress-flush teardown nit** (final review Minor #4): document the pool-destruction race in `runJob`'s TSDoc or add a settle-escape (`Promise.race` with worker-termination signal) — implementer judges which; must not weaken the progress-before-resolution contract or its tests.
4. **`docs/adr/`**: ADR-001 post-intake STL persistence (source bytes discarded — constrains PLAN §6.3 replay-on-source-scans; state the mitigation: journal replay runs on stored post-intake meshes until source-byte retention is added), ADR-002 scene-ops/measurements not journaled (non-destructive rationale), ADR-003 `.ts`-extension import convention, ADR-004 error-taxonomy + job-registry conventions. Short (½–1 page each), template header (status/context/decision/consequences).
5. **Perf re-measurement:** run the perf-guard e2e locally 3× post-change; report rAF max gaps vs the 76.8–102.5 ms baseline (target: ≤ 50 ms now that hashing is off-thread; report honestly whatever is measured and update `e2e/perf.spec.ts` comments + `docs/demos/phase-1.md` footnote if the 100 ms CI gate can tighten).

**Verify:** full chain green (`typecheck && lint && test && test:golden && test:fuzz`); perf numbers reported. Commit.

---

## Task 2 — Halfedge structure (+ intake scalability rebuild)

1. `packages/kernel/src/halfedge/`: `buildHalfedge(mesh: IndexedMesh) → HalfedgeMesh` — typed-array storage (Int32Array/Uint32Array twins/next/vertex/face arrays — NO per-edge objects, NO string keys), boundary halfedges explicit (twin = -1 or boundary-loop convention — document), lazily built overlay per PLAN §2.1 (kernel data of record stays IndexedMesh).
2. `assertValidTopology(he)` — full invariant check (twin involution, next cycles, vertex/face consistency, no dangling), used in ALL halfedge tests and gated into debug builds (env/dev flag, documented) per CLAUDE.md.
3. Iterators: vertex one-ring (vertices/faces/outgoing halfedges), face loop, boundary loops; Euler characteristic + genus helper. All allocation-light (index-based, reusable cursors documented).
4. Non-manifold input policy: `buildHalfedge` REJECTS non-manifold-edge input with a typed error (halfedge is defined for manifold surfaces) — callers repair first (repair ops exist). Bowtie vertices: detected and reported by a `findNonManifoldVertices(mesh)` utility here (fix lands in Task 11).
5. **Intake scalability rebuild (carry-over):** replace `packages/kernel/src/intake/{orient,analyze,topology}` string-keyed edge maps with integer-keyed (e.g. `edgeKey = min*V+max` in a Map<number,…> or sorted typed-array + binary search — measure both, pick, document) and eliminate `number[]`-push accumulation in weld/degenerate (pre-size or grow typed arrays — GrowableUint32Array pattern from io exists). Intake OUTPUT must be bit-identical (golden intake hashes unchanged — this is the regression guard).
6. Perf evidence: intake + halfedge build on the 2.5M-tri generated fixture — report time/RSS vs the 8.5 s / 3 GB baseline; 5M-tri variant (generate a second large fixture at ~5M) MUST complete; report numbers against PLAN §7 NFR.
7. Tests: property (build→assertValidTopology on random manifold meshes from a seeded generator; one-ring completeness vs brute-force adjacency), analytic (icosphere: V-E+F=2, genus 0; torus fixture: genus 1, Euler 0), boundary loops on an open patch, non-manifold rejection, determinism hashes.

**Verify:** full chain green; intake golden hashes UNCHANGED; perf numbers reported. Commit.

---

## Task 3 — Discrete curvature

1. `packages/kernel/src/curvature/`: per-vertex mean curvature H (cotangent-weighted Laplace-Beltrami, mixed Voronoi areas per Meyer et al. — document the exact discretization + obtuse-triangle handling), Gaussian curvature K (angle defect / mixed area), principal curvatures κ1/κ2 derived from H,K (clamped discriminant, documented). Boundary vertices: flagged NaN-free policy (compute with boundary correction or mark `boundary: true` and exclude — document choice; margin detection in Phase 3 uses interior prep surfaces).
2. Worker job `computeCurvature` (per-domain module), progress, cancellation, transferable Float64 outputs (H, K, κ1, κ2 arrays).
3. Dev visualization (cheap, reuses Phase 1 infra): curvature values → existing vertex-color path via the existing diverging colormap; a dev-panel toggle (i18n'd) to color a mesh by H or K. This is scaffolding for Phase 3's margin ridge detection — keep minimal.
4. Tests: analytic — sphere r=5: H = 1/5, K = 1/25 (interior vertices, tolerance derived from tessellation level and DOCUMENTED with its derivation, not tuned); cylinder r=3: H = 1/6, K = 0; torus R=5,r=2: K sign split (outer positive / inner negative) + value spot-checks at extremal rings; property — scale invariance (mesh×2 → H/2, K/4), rigid-motion invariance (bit-tolerance documented), determinism hashes; golden on arch-case-01 upperjaw (hash-stable).

**Verify:** full chain green. Commit.

---

## Task 4 — Geodesic paths & polyline snapping  *(acceptance-critical: < 0.1% vs great circle)*

1. `packages/kernel/src/geodesic/`: shortest path point→point on the surface. Method: edge-graph Dijkstra (with Steiner-point edge subdivision OR exact-window MMP — implementer evaluates both against the acceptance budget; Dijkstra + iterative geodesic straightening (edge-flip/relaxation of the polyline over the surface) is the expected sweet spot) — the CHOSEN method's error characteristics documented with `@errorBound` and the acceptance test proves it. Endpoints are arbitrary surface points (barycentric on a triangle), not just vertices.
2. `snapPolylineGeodesic(mesh, points[]) → on-surface polyline`: consecutive anchor points connected by geodesic segments; anchors projected to surface via BVH first. This is THE primitive Phase 3's margin editing consumes — API shaped for incremental re-snapping of a single moved anchor (document).
3. Worker jobs `geodesicPath`, `snapPolyline` (progress, cancel).
4. Tests: **ACCEPTANCE — icosphere (subdivision high enough that tessellation itself doesn't eat the budget — derive like Phase 1's Task 9/10 fixtures): geodesic length between two random surface points vs analytic great-circle arc r·θ, error < 0.1%, asserted over a seeded set of ≥ 50 point pairs, max error REPORTED**; degenerate cases (same point, antipodal-ish, path crossing many triangles); planar mesh → straight line exactly; determinism; property — path length ≥ Euclidean distance, path lies on surface (all points within weld-ε of mesh).

**Verify:** full chain green; measured max geodesic error reported. Commit.

---

## Task 5 — Cubic splines on mesh surface

1. `packages/kernel/src/spline/`: cubic spline (Catmull-Rom or natural cubic — document choice + parametrization: centripetal recommended against cusps) through ordered control points; open + CLOSED (periodic) variants; arc-length resampling at configurable density.
2. Surface constraint: control points and all resampled points projected to the mesh (BVH closestPoint), with iterative re-projection after smoothing so the final curve lies on the surface within a documented tolerance (`@errorBound`: max off-surface distance, assert ≤ weld-ε × documented factor in tests). Combines with Task 4: optional geodesic-snapped segments between control points (the margin-line editing mode Phase 3 needs — `MarginLine` type in shared-types already has vertexAnchors + controlPoints; wire the produced structure to that shape).
3. Local re-fit: moving ONE control point recomputes only the affected spans (API + test proving locality — Phase 3 interactivity depends on it).
4. Worker job `fitSurfaceSpline` (+ resample/refit entry points).
5. Tests: analytic — control points on a great circle of the sphere → closed spline stays within documented tolerance of that circle (radius deviation asserted); planar square → spline through it stays planar; property — resampling density convergence (finer resampling → arc length converges monotonically within bound), closed-curve continuity at the seam (C1 verified numerically), locality of re-fit (untouched spans bit-identical); determinism.

**Verify:** full chain green. Commit.

---

## Task 6 — Signed distance & SDF sampling

1. `packages/kernel/src/sdf/`: `signedClosestPoint(mesh, p)` — sign via angle-weighted pseudonormals (Bærentzen-Aanæs; correct on faces/edges/vertices — property-test against brute force including queries nearest to edges/vertices), built on the Phase 1 BVH (extend BVH node data if needed; precompute per-mesh pseudonormal arrays keyed alongside the BVH cache).
2. `sampleSdfGrid(mesh, {bboxMm, pitchMm, padding}) → Float64Array grid + dims + origin` — worker job with progress by slices, cancellation, memory guard (grid size sanity ceiling with typed error; document the formula — a 10 mm die at 20 µm pitch ≈ 500³ = 1.25e8 cells ≈ 1 GB Float64 → evaluate Float32 grid storage: ONLY acceptable if the quantization error is included in the documented offset error budget and the acceptance test still passes with margin; otherwise chunked Float64. Decide with math, document in `@errorBound`).
3. Requires watertight input for meaningful sign — validate (analyzeMesh stats or manifold status) and throw typed error otherwise (document that offsets need closed meshes; open-mesh offsets are out of scope this phase).
4. Tests: analytic — sphere: SDF at sampled points vs |p−c|−r within documented bound; sign correctness inside/outside/near-surface; pseudonormal property test vs brute force (seeded random meshes + queries biased to edge/vertex proximity); grid: analytic sphere grid values spot-asserted; determinism hashes; memory-guard rejection test.

**Verify:** full chain green. Commit.

---

## Task 7 — Offset surfaces (SDF → marching cubes → manifold cleanup)  *(acceptance-critical: 50 µm offset, ≤ 10 µm error)*

1. `packages/kernel/src/offset/`: `offsetMesh(mesh, distanceMm, {pitchMm}) → IndexedMesh` — pipeline: SDF grid (Task 6) at iso value = distance → marching cubes (implemented from the standard 15-case/33-config tables — cite table source in comment, no library port; vertex placement by linear interpolation along edges) → weld → manifold-3d cleanup pass through the existing wrapper (validate output watertight/manifold) → stats.
2. `pitchMm` REQUIRED param; `DEFAULT_OFFSET_VOXEL_PITCH_MM = 0.02` exported from `packages/clinical-profiles` (first real export: create `src/constants.ts` + minimal package docs; cite PLAN §3/Phase-2). `@errorBound`: documented bound = pitch/2 + interpolation term (derive honestly); bound carried in the result struct (`errorBoundMm`) per PLAN §6.6 for later QC surfacing.
3. Worker job `offsetMesh` (progress across SDF/MC/cleanup stages, cancellation between slices/stages).
4. Both signs (outward positive / inward negative — sign convention documented; inward offset of sphere shrinks radius — tested).
5. Tests: **ACCEPTANCE — icosphere r=5 (tessellation fine enough per fixture-derivation discipline) offset by +0.050 mm at pitch 0.02: max |radial distance − 5.050| ≤ 0.010 mm asserted over ALL result vertices, measured value REPORTED; same inward (−0.050 → 4.950)**; property — offset(offset(m, d), −d) ≈ m within 2× documented bound (PLAN §6.8's canonical example, on a sphere and a cube-with-fillets synthetic); output watertight+manifold asserted via analyzeMesh + manifold status; cube offset: face-region distance exact within bound, edge/corner rounding radius ≈ d (spot asserts); determinism hashes; golden on standin-prep-die at default pitch (hash + stats).

**Verify:** full chain green; measured max radial errors reported (they are phase acceptance evidence). Commit.

---

## Task 8 — Boolean analytic acceptance + golden regression & journal-replay framework  *(acceptance-critical: 0.1% volume)*

1. **Boolean acceptance:** union/intersect/subtract of the two overlapping analytic spheres (r=3, centers 3 mm apart — lens volume closed form already in fixture sidecars): |mesh volume − analytic| / analytic < 0.1% for all three ops (tessellation contribution derived and shown to fit the budget — increase fixture subdivision if needed with the documented derivation). Max deviations REPORTED.
2. **Golden regression suite for kernel ops** (`test/golden/kernel-ops.test.ts` + `scripts/generate-kernel-goldens.ts`): for a fixed fixture set (synthetic + arch-case-01 upperjaw + standin-prep-die), run each kernel op (intake, curvature, geodesic, spline-fit, sdf-sample [coarse pitch], offset [coarse pitch], booleans, section, repair ops) with pinned params → sha256 of outputs stored in `test-fixtures/golden/kernel-ops.json`; CI compares. **Enforcement:** the goldens file embeds `KERNEL_VERSION`; a test fails if hashes changed while KERNEL_VERSION didn't (message: bump + changelog). `docs/CHANGELOG-kernel.md` created with the policy header.
3. **Journal replay harness** (PLAN §6.3, scoped to what exists): `scripts/replay-journal.ts` + test — record a scripted case journal (import [from stored post-intake mesh per ADR-001], rescale, repair ops) on fixtures, replay it fresh, assert every output hash identical. CI-wired (fast fixture subset).
4. Wrapper hardening leftovers, if any surface while testing (input revalidation gaps) — fix inline, document.

**Verify:** full chain green incl. new golden + replay; measured boolean deviations reported. Commit.

---

## Task 9 — Insertion-axis undercut scan

1. `packages/kernel/src/undercut/`: `undercutScan(mesh, directionUnit) → per-triangle { undercut: boolean, depthMm }` — a triangle is undercut w.r.t. insertion direction d if its outward normal · d > 0 (facing away) — plus occlusion: visibility along −d via BVH raycasts from triangle sample points (centroid + optional 3-corner sampling, documented) to detect shadowed regions; depth = distance to the occluding surface along d (the "how much blockout" number Phase 3's heatmap displays). Exact semantics documented — this is the primitive for PLAN Phase 3's axis optimization, keep the API direction-batched (`undercutScanBatch(mesh, directions[])` for the hemisphere sampling Phase 3 does).
2. Worker job with progress (per-triangle batches), cancellation.
3. Tests: analytic — cylinder (axis = d): zero undercut; tilted cylinder at angle α: undercut band area matches analytic expectation within documented tolerance (THIS pre-verifies PLAN Phase 3's acceptance item early); sphere with d = +z: lower hemisphere undercut, depth at equator ≈ 0 growing toward pole per closed form (spot asserts); overhanging step fixture: occlusion depth exact; determinism; property — depth ≥ 0, non-undercut triangles have depth 0.

**Verify:** full chain green. Commit.

---

## Task 10 — Decimation for render LODs

1. `packages/kernel/src/decimate/`: quadric error metric (QEM) edge-collapse decimation to a target triangle count/error, deterministic collapse ordering (stable priority tie-breaks documented), boundary-preserving; `@errorBound` = max QEM error accepted.
2. **Kernel data of record is NEVER decimated implicitly** (PLAN): decimation output is a separate mesh used ONLY for render copies. Engine: meshes above a triangle budget (named constant, engine-level — not clinical) get an LOD render copy (full-res kernel data untouched; picking/measuring still routes to full-res Float64 via workers — verify the measurement path unaffected); toggle in dev panel; golden kernel hashes MUST remain byte-identical (regression-guarded by Task 8's suite).
3. Worker job `decimateMesh`.
4. Tests: property — output valid (analyzeMesh manifold where input manifold), error monotone with target, determinism; analytic — sphere decimated to 20%: volume within documented bound, all vertices within QEM bound of original surface (BVH-checked); engine test — LOD copy created above threshold, kernel buffers untouched (hash), measurement path still hits full-res.

**Verify:** full chain green; golden hashes unchanged. Commit.

---

## Task 11 — Repair upgrades: curvature-continuous hole fill + bowtie split

1. **fillSmallHoles upgrade** (retires the Phase 1 documented deviation): after ear-clip + relax, a curvature-continuity pass — solve for patch interior positions minimizing bending energy against the boundary ring's cross-boundary curvature (bi-Laplacian/thin-plate solve on the patch with one-ring boundary constraints from the surrounding mesh; document the discretization, reuse Task 3 cotan machinery). Result: G1-ish blend, quantified — test measures dihedral-angle jump across the seam and asserts the documented threshold (target < 5° per PLAN Phase 5's blend language; report measured). Update `@approximation` docs; Phase 1 plan-deviation note in `docs/plans/phase-1-import-viewer.md` gets a one-line "retired in Phase 2 Task 11" edit.
2. **splitNonManifoldVertices** (bowtie): duplicate vertices whose one-ring splits into multiple fans (uses Task 2's `findNonManifoldVertices` + halfedge fan walk); deterministic assignment; after edges+vertices split, `buildHalfedge` must accept the mesh (test: bowtie fixture → split → halfedge builds + assertValidTopology passes).
3. Repair UI cards updated (i18n 4 locales) — bowtie repair appears when detected; hole-fill card notes the improved quality (string tweak).
4. Tests: sphere-with-hole fill: watertight + volume within 0.3% (tighter than Phase 1's 0.5% — quality improved) + seam dihedral < threshold; bowtie fixtures (single + double bowtie) split correctly, determinism; idempotence; golden updates ONLY where op outputs legitimately changed → **this task bumps KERNEL_VERSION + changelog entry** (hole-fill outputs change; Task 8's enforcement test proves the mechanism works for real).

**Verify:** full chain green; kernel version bump + changelog present; measured seam angles reported. Commit.

---

## Task 12 — Client test lane, worker affinity, 5M NFR evidence, phase wrap-up

1. **Browser-capable client test lane:** vitest browser mode (playwright provider) OR jsdom project for `apps/client` UI components — implementer evaluates (browser mode preferred: real DOM + real events, matches repo's no-mock philosophy); migrate/duplicate 3 representative panel tests (RepairPanel conditional render, CasePicker error paths, SurfaceDistancePanel range validation — the very gaps per-task reviews kept flagging) to prove the lane; document conventions for Phase 3.
2. **Worker affinity:** hash-routed slot selection in `WorkerPool` (opt-in per job: jobs declare an affinity key, e.g. mesh contentHash → same worker → BVH/pseudonormal/halfedge caches hit) — replaces the size-1 measurement-pool workaround; measurement pool migrates to the shared pool with affinity; cache-isolation tests updated; pool tests extended (affinity respected, fallback when target worker busy documented — queue vs steal, decide + document).
3. **5M-triangle NFR evidence** (PLAN §7): generated 5M fixture through stream-parse + intake + halfedge + BVH build + one heatmap — timings + peak memory reported in docs; env-gated perf test like the 120 MB one. If any stage fails the "handle it" bar, file the finding honestly in the phase demo doc (do not tune tests to pass).
4. **Phase acceptance wrap:** `docs/demos/phase-2.md` — evidence table: boolean ≤ 0.1% (measured), offset ≤ 10 µm (measured), geodesic < 0.1% (measured), golden suite + replay harness green in CI; demo script (curvature overlay, offset a die, undercut view — what exists UI-wise); full local chain green (`typecheck && lint && test && test:golden && test:fuzz && test:e2e`).

**Verify:** everything above; CI updated where needed. Commit.
