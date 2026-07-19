# Phase 1 — Import & Viewer: Execution Plan

Decomposition of PLAN.md Phase 1 into dispatchable tasks. Branch: `phase-1-import-viewer` (from `main` 557417d).

**Phase acceptance (PLAN.md):** load 5 reference scans incl. a >100 MB arch without UI freeze; distance heatmap between two known-offset synthetic meshes reports the analytic offset within ±1 µm; section through a sphere shows a circle with radius error < 1 µm; parsers pass the fuzz suite.

Real fixtures available: `test-fixtures/real-scans/arch-case-01/` (prepped case — arches contain prepared teeth) and `arch-case-02/`, each with upperjaw/lowerjaw/bite0/bite1 in STL+PLY. Synthetic analytic fixtures in `test-fixtures/synthetic/`.

## Global Constraints (bind every task)

- **Float64** everywhere in `packages/io`, `packages/kernel`, `packages/cad-pipeline`. `Float32Array` only in `apps/client/src/engine/` render copies (+ documented manifold WASM boundary).
- **`packages/io` becomes node-worker-reachable in this phase:** its internal relative imports MUST use literal `.ts` extensions (same convention as kernel/kernel-workers — see CLAUDE.md). Pure TS, zero DOM/Three imports (lint-enforced).
- **Parsers are written from the format specifications, not ported from existing implementations.** Cite the spec facts in comments where behavior is subtle (e.g. PLY property types, STL attribute byte count).
- **No silent data mutation:** unit rescale, repair, normal flips require explicit user confirmation and append a journal `Operation` to the case history.
- **Units mm**; measurement display resolution 1 µm. Weld epsilon fixed 1e-6 mm.
- **UI thread never blocked > 50 ms:** parsing/intake/measurement math runs in the worker pool with progress + cancellation (AbortSignal); buffers move via transferables.
- **Determinism:** identical input bytes ⇒ identical parsed output & identical intake results (stable ordering; no Math.random/Date.now in compute paths).
- **TS strict, no `any`**; ESM; i18n keys in all 4 locales (en/hu/de/es) with parity test; layer rule `ui → engine → kernel-workers → kernel|io` (lint-enforced).
- **Fixtures:** new committed fixtures via Git LFS. The >100 MB perf fixture is NOT committed — generated deterministically on demand (git-ignored path), regenerated in CI.
- **Ports 5173/4100** pinned in committed config. Local caveat: 5173 is often occupied by unrelated servers — verify via temp uncommitted override; never commit overrides.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Task 1 — packages/io: STL parser + writer (binary & ASCII)

From-spec implementation. API in `packages/io/src/stl/`:

1. Types in `packages/io/src/types.ts`: `RawTriangleSoup { positions: Float64Array /* 9 per tri */; normals: Float64Array | null /* 3 per tri, file normals as-read */; triangleCount: number }`, `ParseDiagnostics { warnings: string[]; format: 'stl-binary' | 'stl-ascii' | ... }`, typed error classes `IoParseError` (base, with byteOffset/line context), `TruncatedFileError`, `MalformedSyntaxError`.
2. `parseStl(bytes: Uint8Array): { soup: RawTriangleSoup; diagnostics }` — auto-detects binary vs ASCII robustly (NOT just "starts with solid": check byte length consistency 84+50n; note spec fact in comment). Binary: little-endian, 50-byte stride, attribute byte count read (warn if non-zero, never fail); tolerates trailing junk with warning. ASCII: tolerant whitespace/case per spec grammar, scientific notation, multiple `solid` blocks → error with line number.
3. `writeStlBinary(soup, headerText?)` — 80-byte header (default `DQCAD export`, zero-padded, sanitized ASCII), correct counts, recomputed outward normals optional flag (default: write per-triangle geometric normal).
4. All coordinates parsed straight into Float64Array. No intermediate number[] for bulk data (memory).
5. Tests (vitest project `io`): golden — parse all 5 synthetic fixtures + all 8 real-scan STLs, assert triangle counts/bboxes match the existing `expected.json`/`manifest.json` sidecars; property (fast-check) — writeStlBinary→parseStl round-trip preserves positions bit-exactly; error cases — truncated binary, bad ASCII token, empty file, 83-byte file; determinism — same bytes parsed twice → hash-identical Float64 buffers.

**Not in scope:** streaming (Task 3), PLY (Task 2), intake/welding (Task 4 — the soup stays a soup here).

**Verify:** `npm run lint && npm run typecheck && npm test` green. Commit.

---

## Task 2 — packages/io: PLY parser + writer (binary LE/BE + ASCII)

From-spec, header-driven. `packages/io/src/ply/`:

1. Header parser: `ply` magic, `format ascii|binary_little_endian|binary_big_endian 1.0`, `comment`/`obj_info` (collected into diagnostics), `element <name> <count>`, `property <type> <name>` and `property list <countType> <itemType> <name>`. All 8 scalar types (char/uchar/short/ushort/int/uint/float/double + int8/uint8/... aliases per spec). NEVER assume property order — read layouts from the header.
2. Body readers for all three formats. Output `PlyMesh { positions: Float64Array; normals: Float64Array | null; colors: Float64Array | null /* normalized 0-1 */; indices: Uint32Array; vertexCount; faceCount; diagnostics }`. Faces: triangles pass through; quads fan-triangulated (warning); >4-gons → fan + warning; non-uniform list counts handled per-face. Unknown elements/properties skipped correctly by computed stride (binary) or token count (ASCII) — this is the classic PLY trap, test it explicitly.
3. Writer: `writePlyBinaryLE(mesh, { comments? })` — positions (+ normals/colors when present), triangle faces, `comment` lines sanitized.
4. Float64 output; big-endian path via DataView (no byte-swap hacks on typed arrays).
5. Tests: golden — parse all 8 real-scan PLYs, assert vertex/face counts match manifests; synthetic — hand-built tiny fixtures exercising: BE binary, ASCII, list uchar/uint variants, extra unknown element ("edge"), reordered properties (z y x), double-typed positions, per-vertex color; property — writer→parser round-trip bit-exact for positions; determinism hash test; error cases — bad magic, count overflow, truncated body (exact byte), list count exceeding remaining bytes.

**Verify:** lint/typecheck/test green. Commit.

---

## Task 3 — packages/io: fuzzing + chunked parsing for large files

1. **Fuzz suite** (`npm run test:fuzz`, separate vitest project `fuzz`, excluded from default `npm test`): fast-check structured fuzzers — (a) mutation fuzzing: take valid small STL/PLY bytes, flip/truncate/insert bytes at random (seeded) positions, parser must throw a typed IoParseError or return a valid mesh — never hang, never throw non-IoParseError, never return NaN/Infinity coordinates silently (assert on success paths); (b) generative: random valid headers with random property layouts → parse must succeed and match the generated ground truth. Seeded runs (fast-check seed logged); a small committed regression corpus in `test-fixtures/fuzz-corpus/` (text-only or LFS) for previously-found failures (seed the corpus with any failures found during development).
2. **Chunked parsing:** `parseStlStream` / `parsePlyStream` accepting an async byte-chunk iterator, O(chunk) memory for header/ASCII scanning, single pre-allocated Float64 output (counts known from header/tri count). Progress callback (0..1 by bytes). Wire as worker jobs (`parseMeshFile`) with transferable output + progress + cancellation between chunks. In-memory `parse*` delegates to the same core.
3. **Large perf fixture:** `scripts/generate-large-fixture.ts` — deterministic ~120 MB binary STL (dense arch-like surface, e.g. highly subdivided standin arch), written to `test-fixtures/generated/` (git-ignored; `.gitattributes` untouched). Node-side perf test (vitest `io`, tagged slow/skippable via env): stream-parse completes, peak extra memory bounded (no full intermediate copies), progress monotonic.
4. CI: add `npm run test:fuzz` (bounded run count) after unit tests.

**Verify:** fuzz suite green locally (report seed + run counts); large-fixture stream parse test green; lint/typecheck/test green. Commit.

---

## Task 4 — packages/kernel: mesh intake pipeline

`packages/kernel/src/intake/` — pure Float64, deterministic:

1. `weldVertices(soup, epsilon = 1e-6)` → `IndexedMesh` — spatial-hash grid dedup (quantized cells; document that epsilon is a fixed clinical constant from PLAN §3), stable first-occurrence ordering (determinism).
2. `dropDegenerateTriangles(mesh)` — zero-area (cross-product norm < 1e-12 mm²) and duplicate-index triangles removed; returns removal stats.
3. `orientNormalsConsistently(mesh)` — flood-fill orientation across shared edges per component; component majority vote against signed volume for outward orientation of closed components; returns flip stats. Open components: consistent within component, flagged `orientationAmbiguous`.
4. `analyzeMesh(mesh)` → `MeshStats { watertight, manifoldEdges (every edge shared by exactly 2 tris), componentCount, bbox, surfaceAreaMm2, signedVolumeMm3 (closed only), degenerateCount, boundaryEdgeCount }`. Self-intersection check deferred to manifold construction (document: full check happens at boolean/QC time via manifold-3d status; intake reports topological facts only).
5. `intake(soup, opts)` — composes 1–4 → `{ mesh, stats, report: IntakeReport }` where `IntakeReport` is journal-ready (counts before/after each step). Progress callbacks between stages.
6. Worker job `intakeMesh` wired in kernel-workers (transferables, progress, cancellation).
7. Tests: property (fast-check) — weld idempotent (weld(weld(m))==weld(m)); welding a soup built from an indexed mesh reproduces it; analytic — synthetic sphere fixture: watertight true, volume/area within existing sidecar tolerances; cylinder likewise; a deliberately duplicated-vertex soup welds to exact expected count; flipped-normals sphere reorients to positive signed volume; real fixtures — intake of arch-case-01 upperjaw STL completes, stats recorded as a new golden snapshot (counts hash-stable); determinism — double run hash-identical.

**Not in scope:** repair (hole filling etc.) — Task 8.

**Verify:** lint/typecheck/test green (incl. `test:kernel`). Commit.

---

## Task 5 — Client import flow (files → workers → scene)

1. `apps/client/src/engine/importer.ts` — orchestrates: File/Blob → chunked worker parse (progress) → intake job (progress) → mesh registered in an engine-side `MeshStore` (Float64 master copy in worker/engine memory + Float32 render copy, re-centered at case bbox centroid per CLAUDE.md).
2. **Unit heuristic + confirmation:** bbox-based heuristic (arch ≈ 40–80 mm; if bbox max extent < 8 mm suspect cm, > 400 mm suspect µm — thresholds as named constants with comment). ALWAYS show a confirmation dialog when a rescale is suggested (options: keep as mm / apply suggested factor); rescale is applied in Float64 in a worker and journaled as an `Operation` (name `unit-rescale`, params factor, input/output hashes). No rescale without explicit user choice — no timeout defaults.
3. UI: drag&drop overlay + file picker button (STL/PLY filter); per-file progress list with cancel buttons; intake summary panel (stats from Task 4: watertight/manifold/components/bbox/area/volume, warnings); role assignment dropdown per imported mesh (`upperJaw|lowerJaw|prepDie|antagonist|situ|gingiva`) writing `SceneNode`s into a new zustand `caseStore` (document snapshot published from engine `CaseStore` — engine owns canonical state, UI subscribes; same pattern as appStore).
4. Scene tree sidebar: real tree (replaces placeholder) — per-node: name, role icon, visibility toggle, opacity slider, remove. All strings i18n'd (4 locales).
5. Journal: importing a mesh appends `Operation` (`import-mesh`, source filename SANITIZED — basename only, params: format, counts, contentHash). CaseDocument held in engine `CaseStore` (in-memory this task; persistence Task 10).
6. Tests: engine importer unit tests with worker pool (node path) on small fixtures; unit-heuristic table-driven tests (mm/cm/µm cases incl. boundary values); caseStore/i18n parity tests. Playwright covers the dialog in Task 11.

**Verify:** lint/typecheck/test green; manual dev-server check: import a real-scan STL, see progress + stats + tree node (report evidence; temp port override allowed). Commit.

---

## Task 6 — Viewer core (real SceneManager)

Replaces the placeholder scene. All Three.js inside `apps/client/src/engine/`:

1. Mesh rendering from Float32 render copies (indexed BufferGeometry, computed vertex normals), re-centered local frame (store the Float64 world offset for coordinate readouts).
2. Cameras: perspective + orthographic toggle (shared controls state); orbit/pan/zoom with configurable mouse bindings (a `ViewerBindings` map — rotate/pan/zoom per button; settings UI can come later, structure now), damping; `frameAll` / `frameSelection`.
3. Standard views, jaw-aware: occlusal/buccal/lingual/mesial/distal/front computed from the scene's jaw roles (upper vs lower flips occlusal direction — document the convention); view buttons in a small toolbar + numeric keys.
4. Shading presets: `matcap` (bundled neutral matcap texture — generate procedurally or embed data-URI, no external fetch), `clinical` (hemisphere + directional, slight warm tint), wireframe overlay toggle, per-mesh opacity (from scene tree) with correct transparent-object render order.
5. Dark/light theme reactive background + grid; dispose() correctness for all created GPU resources (geometry/material/texture) — extend the existing dispose pattern, fix the known GridHelper leak from Phase 0.
6. Selection: click-pick via raycast against render meshes (closest hit), highlight material, selection state in caseStore (needed by measurements Task 7).
7. Tests: engine-level unit tests for view-direction math (pure functions, jaw-aware matrix expectations) and render-copy re-centering (Float64→Float32 offset bookkeeping exact); i18n parity for new strings. GPU behavior verified via e2e screenshots in Task 11.

**Verify:** lint/typecheck/test green; manual check: load both real cases (4 meshes), orbit/pan/zoom smooth, standard views correct for upper vs lower, opacity/visibility work (report evidence). Commit.

---

## Task 7 — kernel BVH + point measurements

1. `packages/kernel/src/bvh/` — static triangle BVH (median-split or SAH, document choice), Float64: `closestPoint(mesh, p)` (exact point-triangle distance), `raycast(mesh, origin, dir)` (watertight ray-tri per Woop/Möller-Trumbore with documented epsilon policy), both with deterministic tie-breaking (lowest triangle index wins on exact ties).
2. Worker jobs: `buildBvh` (cached per mesh contentHash in worker memory; explicit `releaseBvh`), `measurePointToSurface`, `raycastMesh`.
3. Measurement tools (engine `ToolManager` beginnings + UI): point-to-point distance (two surface picks — pick point = raycast hit in Float64 world coords, NOT Float32 render coords: shoot the ray in the worker against the Float64 mesh), point-to-surface (pick point on mesh A, target mesh B), angle (three points). Results panel listing measurements with µm-resolution formatting (`formatMm(value)` util: shows mm with 3 decimals + µm where < 1 mm; i18n'd labels); measurements stored in caseStore; deletable; simple line/label overlays rendered by the engine (screen-space labels, HTML overlay layer — no geometry text).
4. Tests: BVH property tests vs brute force (fast-check, random small meshes: closestPoint/raycast equal brute-force within 1e-12); analytic — distances on the synthetic sphere (point at 2r from center → distance r within 1e-9); determinism; worker-path integration test; formatMm table-driven tests (µm rounding).

**Verify:** lint/typecheck/test green; manual: measure between two picked points on a real scan, value plausible + stable (report). Commit.

---

## Task 8 — Repair operations (user-approved, journaled)

`packages/kernel/src/repair/` + UI:

1. `removeComponents(mesh, keepIds | minTriangles)` — small-component removal with preview stats.
2. `splitNonManifoldEdges(mesh)` — duplicate non-manifold edges/vertices so every edge has ≤ 2 faces; stats.
3. `fillSmallHoles(mesh, { maxBoundaryEdges (default 32), maxAreaMm2 })` — boundary-loop detection, ear-clipping fill + local Laplacian relax of the new patch. **Document honestly in TSDoc `@errorBound`/`@approximation`: the fill is smooth but NOT strictly curvature-continuous; PLAN.md's curvature-continuous refinement is deferred to the Phase 2 kernel (tracked in the plan-deviation note in docs/plans/phase-1-import-viewer.md §Deviations).** Refuse (skip + report) holes exceeding limits.
4. All three as worker jobs with progress; each produces a journal-ready report (before/after stats, params).
5. UI: "Repair" panel appearing when intake stats show issues — each repair listed with its preview stats, explicit apply button per repair (no auto-apply, no bulk-apply-all default), applied repair appends `Operation` (`repair-remove-components` etc.) with input/output hashes; result mesh replaces the scene mesh (render copy refreshed).
6. Tests: analytic — sphere with N deleted triangles: fillSmallHoles restores watertightness, volume within 0.5% of original; cube with a doubled face edge: splitNonManifoldEdges yields manifoldEdges true; two-component fixture: removeComponents keeps the right one; property — repairs idempotent where applicable (second run = no-op); determinism hashes; journal entry shape test.

### Deviations (Phase 1)

- Hole filling ships smooth-but-not-curvature-continuous in Phase 1 (documented at the API); curvature-continuous upgrade lands with the Phase 2 curvature machinery. QC gates (Phase 4+) treat filled regions like any other geometry. **Retired in Phase 2 Task 11** — see `docs/CHANGELOG-kernel.md`'s `[0.2.0]` entry.

**Verify:** lint/typecheck/test green. Commit.

---

## Task 9 — Surface-to-surface distance heatmap

1. New synthetic fixture pair (extend `scripts/generate-fixtures.ts` + sidecars + LFS): `offset-pair-inner.stl` / `offset-pair-outer.stl` — icosphere r=5 and r=5.05 (analytic offset exactly 50 µm everywhere), plus a plane-pair at exact 17 µm for a second known value.
2. Worker job `distanceHeatmap(meshA, meshB, { signed?: boolean })` — per-vertex of A: closest-point distance to B via BVH (Float64); returns Float64Array distances + min/max/mean/RMS stats; progress + cancel; deterministic.
3. Rendering: distance array → per-vertex colors on the render copy via a diverging colormap (blue−0 → white → red+, symmetric range auto from percentile with manual override); legend UI with µm tick labels (1 µm resolution), range controls; heatmap togglable per mesh pair; colormap math in engine (pure function, unit-tested — no kernel dependency on colors).
4. UI: measurement panel "surface distance" mode — pick mesh A and B from scene tree, run with progress, stats summary (min/max/mean/RMS in µm) + legend.
5. Tests: **acceptance-critical analytic test — heatmap inner→outer sphere pair: every vertex distance within ±1 µm of 50 µm (assert max abs deviation ≤ 1e-3 mm); plane pair likewise at 17 µm.** Property: heatmap(A,A) ≡ 0 exactly. Determinism hash. Colormap unit tests (value→RGB table).

**Verify:** lint/typecheck/test green — the ±1 µm assertions are the phase acceptance, report their measured deviations. Manual: heatmap between bite0 and lowerjaw of arch-case-01 renders sensibly (report). Commit.

---

## Task 10 — Cross-sections + SVG export

1. Kernel `packages/kernel/src/section/`: `sectionMesh(mesh, plane { point, normal })` → ordered closed/open polylines (Float64) — edge-plane intersection with robust handling of vertices exactly on plane (documented epsilon policy, deterministic traversal order); for closed watertight meshes also compute filled-cap polygons via manifold-3d `slice`/cross-section API (wrapper in kernel/boolean area; validate inputs like the boolean wrapper).
2. Worker job `sectionMesh` with progress.
3. Viewer: section tool — axis-aligned plane presets (X/Y/Z through bbox center) + arbitrary plane (position along normal via slider + drag handle in viewport; rotation via two angle sliders this phase), live outline overlay (line segments from polylines), optional filled-cap display, clip-plane rendering (three.js clipping planes on the sectioned mesh, local-frame corrected).
4. SVG export: `sectionToSvg(polylines, { scale, strokeWidth })` — mm-true viewBox (1 unit = 1 mm), closed paths, downloadable file (engine util + UI button). Pure function, unit-tested (path data snapshot).
5. Tests: **acceptance-critical analytic test — section of synthetic sphere r=5 through center: every polyline point at distance 5 mm from center within < 1 µm (assert ≤ 1e-3 mm); off-center plane at h → circle radius √(r²−h²) within 1 µm.** Torus section point-count sanity; open-mesh section (plane through boundary) yields open polylines without crash; determinism hash; SVG snapshot test.

**Verify:** lint/typecheck/test green — report the measured radius deviations. Manual: drag a section plane through a real arch, outline + cap look correct (report). Commit.

---

## Task 11 — Scene persistence (save/load/autosave)

1. Server: content-addressed mesh storage — `POST /api/meshes` (raw bytes, server computes sha256, stores under `apps/server/data/meshes/<hash>` (git-ignored), returns hash; idempotent on re-upload), `GET /api/meshes/:hash`, `HEAD /api/meshes/:hash`; JSON-schema'd; size limit configurable (default 300 MB); stored files immutable (write-once: reject overwrite with different bytes — impossible by construction, assert anyway).
2. Case document: `PUT /api/cases/:id` (full CaseDocument JSON, schema-validated against shared-types shape, schemaVersion checked), `GET /api/cases/:id`. `updatedAt` maintained.
3. Client `CaseStore` (engine): serialize current state (scene nodes with roles/transforms/visibility, mesh registry by contentHash, journal ops, measurements) into `CaseDocument`; save = upload any mesh bytes not yet on server (HEAD check first) + PUT document; load = GET document + fetch/parse/intake-skip (meshes stored post-intake as binary STL — document this choice: intake happens once at import, stored mesh is the welded result) + rebuild scene; autosave debounced 30 s after last mutating op, status indicator in header (saved/saving/unsaved + error state), manual save button (Cmd/Ctrl+S).
4. Case picker UI: list cases (existing GET /api/cases), open, create new, rename (PATCH name — add route).
5. Tests: server routes via inject (upload/fetch round-trip byte-identical, idempotent re-upload, oversized rejected, PUT validates schema, PATCH rename); client CaseStore serialize→deserialize round-trip preserves state deep-equal; journal ops preserved order-exact; autosave debounce unit test (fake timers).

**Verify:** lint/typecheck/test green; manual: import case → save → reload page → open case → identical scene (report). Commit.

---

## Task 12 — Phase 1 e2e, CI, acceptance wrap-up

1. Playwright e2e additions (`e2e/phase1.spec.ts`): import a real-scan STL via file input → intake stats visible → assign role → standard view buttons change camera (screenshot assertions on canvas pixels are flaky — assert on state/store-exposed test hooks instead, document approach) → measure point-to-point on synthetic sphere fixture (value within tolerance shown) → section tool opens → save case → reload → case restores (tree node count + names). Use small synthetic fixtures where speed matters; one real-scan import to prove the pipeline.
2. Perf guard: e2e (or vitest node test if more reliable) — stream-parse the generated ~120 MB fixture through the worker path while asserting the UI thread stays responsive: Playwright evaluates a rAF-heartbeat monitor during import; no gap > 50 ms per the NFR... document measured max gap honestly; if the strict 50 ms is flaky in CI, gate on 100 ms in CI with the 50 ms target measured+reported locally (note as deviation if needed).
3. CI: `test:fuzz` (bounded) + large-fixture generation + the perf-tagged test on a schedule-or-label basis if too slow for every push (document decision in ci.yml comments); Playwright now runs both smoke + phase1 specs.
4. `docs/demos/phase-1.md`: short demo script (what to click) + record the acceptance evidence (all four acceptance criteria with measured numbers, linked test names).
5. Full local acceptance run: `npm run typecheck && npm run lint && npm test && npm run test:golden && npm run test:fuzz && npm run test:e2e` all green — capture in report.

**Verify:** all green locally; docs/demos entry exists. Commit.
