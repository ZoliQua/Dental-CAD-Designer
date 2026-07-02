# 🦷 DQ-Dental-CAD — Implementation Plan

**Standalone dental CAD application: STL/PLY viewing and design of crowns, inlays/onlays, and bridges.**

Stack: React 18 + TypeScript (frontend), Node.js/Fastify (backend), Three.js (rendering), WASM geometry kernel (computation). Runs standalone; later integratable as a module into the DentalQuoteCreator ecosystem (same pattern as React-Dental-CBCT-Viewer and React-Odontogram-Modul).

**Guiding principle: accuracy over speed.** Every geometric result must be clinically trustworthy. Long computation with a progress bar is acceptable; a silently wrong margin line is not.

---

## 1. Product Scope

### 1.1 In scope (this plan)

- Import/export STL (binary + ASCII) and PLY (binary LE/BE + ASCII) meshes
- Full 3D viewer: orbit/pan/zoom, standard views, cross-sections, measurements, scene tree
- Case setup: jaw scans, prep die, antagonist, situ/wax-up scans, FDI tooth assignment
- Margin line: curvature-assisted auto-proposal + manual spline editing on the mesh surface
- Insertion axis + undercut analysis
- Crown design: cement-gap offset inner surface, anatomical library outer surface, morphing, contact/occlusion adaptation, freeform sculpting
- Inlay/onlay design: cavity-driven geometry
- Bridge design: multi-unit frameworks, pontics, connectors with cross-section validation
- Manufacturing export: watertight binary STL + machine-readable QC report
- Case persistence with full design-step history (undo/redo, reopen at any step)

### 1.2 Out of scope (future phases, listed in §10)

Implant abutments, dentures, aligners, virtual articulator with dynamic occlusion, AI margin detection, intraoral scanner integrations, multi-user collaboration.

### 1.3 Users

Dental technicians and dentists doing chairside/lab CAD. UI languages: EN, HU, DE, ES (reuse i18n pattern from existing modules).

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Browser                                                     │
│                                                             │
│  React UI shell (panels, wizard, i18n, theme)               │
│      │  commands / state subscription (zustand)             │
│  ┌───▼──────────────────────────────────────────────┐       │
│  │ Engine (imperative TS, NON-React)                │       │
│  │  • SceneManager (Three.js, Float32 render copies)│       │
│  │  • ToolManager (active tool state machine)       │       │
│  │  • CaseStore (canonical doc, undo/redo journal)  │       │
│  └───┬──────────────────────────────────────────────┘       │
│      │ Comlink RPC (transferable buffers)                   │
│  ┌───▼──────────────────────────────────────────────┐       │
│  │ Geometry Workers (Web Worker pool)               │       │
│  │  • kernel-core (TS, Float64): halfedge, curvature│       │
│  │    geodesics, splines, offsets, ray/distance     │       │
│  │  • manifold-3d (WASM): booleans, mesh repair,    │       │
│  │    guaranteed-manifold outputs                   │       │
│  │  • io: STL/PLY parse & serialize                 │       │
│  └──────────────────────────────────────────────────┘       │
└───────────────┬────────────────────────────────────────────┘
                │ REST + WebSocket (job progress)
┌───────────────▼────────────────────────────────────────────┐
│ Node.js backend (Fastify + Prisma + SQLite)                 │
│  • Case/project CRUD, file storage (content-addressed)      │
│  • Tooth library management (anatomy templates, versioned)  │
│  • Export jobs: runs the SAME kernel (Node+WASM) as an      │
│    independent re-validation before any file leaves the app │
│  • Settings, material profiles, audit log                   │
└────────────────────────────────────────────────────────────┘
```

### 2.1 Key decisions and rationale

| Decision | Choice | Rationale |
|---|---|---|
| Rendering | Plain Three.js in an imperative engine layer; React only for UI shell | Same proven pattern as the Odontogram engine and CBCT viewer; avoids React reconciliation in hot paths; full control over buffers |
| UI state | zustand (engine publishes snapshots) | Frequent small updates from engine → UI without context re-render storms |
| Geometry kernel | Custom TS core (Float64) + `manifold-3d` WASM for booleans/repair | Manifold guarantees manifold, self-intersection-free boolean output — the single most failure-prone CAD operation. Custom core keeps margin/spline/curvature math auditable and testable |
| Precision | **Float64 everywhere in the kernel.** Float32 exists only in render-copy buffers | Accuracy-over-speed requirement. Prep dies are small (~10 mm) with 50 µm features; float32 accumulates visible error through chained operations |
| Heavy compute | Web Worker pool, transferable ArrayBuffers, cancellable jobs | UI never blocks; determinism preserved (see §6) |
| Backend DB | SQLite via Prisma | Standalone/local-first; same ORM as DentalQuoteCreator → easy later migration to PostgreSQL |
| Export validation | Backend re-runs all QC gates independently before writing the file | Two independent code paths must agree before a mesh goes to a mill/printer |
| Mesh data structure | Indexed triangle mesh + lazily-built halfedge overlay | Halfedge needed for geodesics, margin snapping, curvature; indexed form for I/O and rendering |

### 2.2 Canonical data model (CaseDocument)

```ts
CaseDocument {
  id, schemaVersion, createdAt, patientRef?        // optional link to DentalQuoter later
  meshes: MeshAsset[]        // immutable, content-hashed source scans
  scene: SceneNode[]         // transforms, visibility, roles (upperJaw|lowerJaw|prepDie|antagonist|situ|gingiva)
  restorations: Restoration[]
  history: Operation[]       // append-only journal → undo/redo & full reproducibility
  settings: CaseSettings     // material profile, gaps, thickness minimums
}

Restoration {
  id, type: 'crown'|'inlay'|'onlay'|'bridge'
  teeth: FdiTooth[]                        // bridge: abutments + pontics
  marginLines: Record<FdiTooth, MarginLine> // spline on mesh: {vertexAnchors, controlPoints[Float64], closed}
  insertionAxis: Vec3
  params: RestorationParams                 // cement gap, spacer, thicknesses, contact strengths
  stages: { innerSurface?, anatomyPlacement?, morphState?, finalMesh? }  // hashes into mesh store
  qc: QcReport | null
}
```

Every destructive operation appends an `Operation` (op name, params, input hashes, output hashes, kernel version). Replaying the journal on the source scans MUST reproduce identical output hashes — this is the reproducibility invariant (§6).

---

## 3. Clinical parameters (defaults — all configurable per material profile)

These numbers are the "dental reliability" contract. They ship as versioned material profiles, are shown in the UI with units, and are enforced by QC gates.

| Parameter | Default | Range | Notes |
|---|---|---|---|
| Cement gap (spacer) | 50 µm | 20–120 µm | Starts 0.5–1.0 mm above margin |
| Marginal gap (at margin line) | 20 µm | 0–50 µm | Tighter zone near margin |
| Min wall thickness — zirconia | 0.5 mm | ≥ 0.4 | Monolithic; framework 0.5 |
| Min wall thickness — lithium disilicate (e.max) | 1.0 mm occlusal / 0.8 axial | — | Per IFU |
| Min wall thickness — metal | 0.3 mm | — | |
| Min wall thickness — PMMA (temp) | 1.0 mm | — | |
| Bridge connector cross-section — posterior | 9 mm² | 7–16 mm² | Zirconia default; metal lower |
| Bridge connector cross-section — anterior | 7 mm² | — | |
| Proximal contact penetration | +20 µm | −50…+100 µm | Positive = intentional interference |
| Occlusal contact | 0 µm | −200…+100 µm | Negative = relief |
| Undercut blockout threshold | 0 µm | — | Relative to insertion axis |
| Mesh weld tolerance | 1e-6 mm | fixed | Vertex dedup epsilon |
| Export max chord deviation | 5 µm | 1–20 µm | If retessellation is applied |

Material profiles are JSON files with a schema + checksum; changing a profile is an audited operation.

---

## 4. Phases

Each phase ends with: all acceptance criteria met, tests green, demo scenario recorded in `docs/demos/`. Do not start a phase before the previous one's acceptance criteria pass.

### Phase 0 — Foundation (scaffolding)

- Monorepo layout (see §5), Vite + React + TS strict, Fastify + Prisma + SQLite, ESLint/Prettier, Vitest + Playwright, CI (typecheck, lint, unit, e2e-smoke)
- Worker pool infrastructure with Comlink, transferable-buffer helpers, job cancellation, progress events
- `manifold-3d` WASM integrated in both browser worker and Node
- Test-data pipeline: synthetic analytic meshes (sphere, torus, cylinder, boolean pairs with known volumes) + at least 3 real scan fixtures (prep die, full arch, antagonist) checked into `test-fixtures/` via Git LFS

**Acceptance:** `npm run dev` boots UI+server; a worker round-trips a mesh buffer; CI green.

### Phase 1 — Import & Viewer

- **Parsers (in workers):** STL binary/ASCII, PLY binary LE/BE/ASCII with arbitrary property layouts (position, normal, color). Written from spec, not ported. Fuzz-tested. Streaming for >100 MB files
- **Unit & sanity heuristics:** detect µm/mm/cm-scaled files (bounding-box heuristic), always confirm with user dialog — never silently rescale
- **Mesh intake pipeline:** dedup vertices (weld ε), drop degenerate triangles, orient normals consistently, report: watertight? manifold? self-intersections? component count, bbox, area, volume
- **Repair (optional, user-approved):** hole filling (small holes only, curvature-continuous), non-manifold splitting, component removal — every repair is a journal operation with before/after stats
- **Viewer:** orbit/pan/zoom (configurable mouse bindings), perspective+ortho, standard views (occlusal, buccal, lingual, mesial, distal — jaw-aware), scene tree with roles/visibility/opacity, matcap + clinical shading presets, dark/light theme
- **Cross-sections:** arbitrary plane + axis-aligned, draggable, showing filled caps (via manifold slice), 2D section outline export (SVG)
- **Measurements:** point-to-point distance, point-to-surface, angle, surface-to-surface distance heatmap (two selected meshes, color-mapped, µm legend) — all computed in Float64 in workers, displayed with 1 µm resolution
- **Scene persistence:** save/load case (backend), autosave

**Acceptance:** load 5 reference scans incl. a 150 MB arch scan without UI freeze; distance-heatmap between two known-offset synthetic meshes reports the analytic offset within ±1 µm; section through a sphere shows a circle with radius error < 1 µm; parsers pass fuzz suite.

### Phase 2 — Geometry Kernel Core

All Float64, all in workers, all property-tested.

- Halfedge structure with validation (`assertValidTopology` used in tests and debug builds)
- Discrete curvature (mean/Gaussian, per-vertex, cotangent weights)
- Geodesic paths & geodesic snapping of polylines to the surface (for margin editing)
- Cubic spline on mesh surface: control points constrained to surface, resampling, closed curves
- Signed distance queries mesh↔mesh (BVH, exact triangle distance)
- Offset surfaces: distance-field based (sample → SDF → marching cubes at configurable voxel pitch, default 20 µm for die-sized inputs) followed by manifold cleanup; document error bound = voxel pitch/2
- Booleans, union/subtract/intersect via manifold-3d; wrapper enforces: inputs watertight, outputs re-validated
- Decimation ONLY for render LODs (kernel data never decimated implicitly)
- Ray casting, insertion-axis undercut scan (directional visibility per triangle)

**Acceptance:** golden-file regression suite; boolean of two analytic spheres matches analytic volume within 0.1%; offset of a sphere by 50 µm has max radial error ≤ 10 µm at default pitch; geodesic on icosphere vs analytic great-circle length error < 0.1%.

### Phase 3 — Case Setup, Margin Line, Insertion Axis

- Case wizard: assign roles to imported meshes, pick restoration type + FDI teeth (reuse FDI/Universal/Palmer utilities from React-Odontogram-Modul)
- Optional alignment step: ICP fine-registration (e.g. situ scan → prep scan), point-triple coarse alignment first; report RMS error, require user confirmation
- **Margin line tool:**
  - Auto-proposal: user clicks once inside the prep; curvature ridge detection walks the finish line; result shown as editable spline
  - Manual editing: add/move/delete control points, points geodesically snapped to surface; local re-fit; magnifier widget around cursor
  - Validation: closed, non-self-intersecting, lies on prep mesh (max deviation < weld ε), curvature-smoothness warning flags
- **Insertion axis tool:** suggest axis minimizing undercut area (sampled optimization over direction hemisphere); manual adjust with live undercut heatmap (µm depth color map); per-restoration axis; bridges get one common axis with per-abutment undercut report
- Undercut blockout preview (virtual wax) for the inner-surface stage

**Acceptance:** on 3 real prep fixtures, auto margin proposal is within 100 µm (mean) of a hand-traced reference polyline for ≥ 90% of its length; margin validation rejects seeded self-intersections; undercut map on a tilted cylinder matches analytic expectation.

### Phase 4 — Crown Design

The core pipeline. Order of stages is fixed; each stage's output is journaled.

1. **Inner surface:** prep region inside margin → offset by marginal gap near margin, cement gap above spacer start line (smooth blend between zones) → undercut blockout relative to insertion axis → skirt to margin line (exact margin adaptation: inner surface boundary == margin spline)
2. **Anatomy placement:** tooth library (see below) → auto-place by tooth number using neighbors' bounding boxes and occlusal plane → manual transform (position/rotation/scale, anatomical handles)
3. **Adaptation/morphing:** RBF/cage deformation of the library tooth to: reach proximal contacts at target penetration, respect antagonist at target occlusal contact, blend to margin. Contacts visualized as µm heatmaps; interactive sliders re-run adaptation
4. **Shell construction:** outer anatomy + inner surface + margin band → single watertight solid (manifold boolean/stitch); minimal-thickness check against material profile with heatmap; auto-thicken option (bounded, re-checked)
5. **Freeform tools:** add/remove/smooth brushes (volume-aware, symmetric falloff), applied to outer surface only unless explicitly unlocked; every stroke journaled (coalesced)
6. **QC stage:** full gate run (§6) → QcReport stored on the restoration

**Tooth library:** start with an open anatomical tooth set (32 permanent teeth) stored as versioned assets in the backend; morph targets for cusp height/width. Library format documented so technicians can import their own libraries later.

**Acceptance:** end-to-end crown on fixture prep passes all QC gates; margin fit: max gap between crown margin and margin spline ≤ 10 µm; simulated seating (boolean crown ∩ prep die) shows zero penetration beyond configured interference; thickness gate blocks a deliberately thin design; full redesign reproducible from journal (identical hashes).

### Phase 5 — Inlay / Onlay

- Cavity-driven variant of the crown pipeline: margin line traces the cavity outline; inner surface = cavity offset with insertion-axis blockout; outer surface = occlusal anatomy patch blended into surrounding tooth surface (curvature-continuous boundary blend)
- Proximal box handling (Class II): separate contact adaptation for the box walls
- Onlay = inlay + cusp-coverage regions selected on the tooth; thickness rules switch to onlay minimums

**Acceptance:** inlay on a fixture MOD cavity passes QC; boundary blend is G1-continuous (dihedral angle < 5° along seam); seating simulation clean.

### Phase 6 — Bridge

- Multi-unit case setup: abutments (crown pipeline per abutment, shared insertion axis) + pontics (library teeth, gingival interface: hygienic/ovate/modified-ridge-lap against gingiva mesh with configurable relief/pressure)
- Connectors: auto-placed between units, editable cross-section curves (2 closed 2D profiles), live cross-section area readout, gate enforces material minimum area per connector position (anterior/posterior)
- Framework mode (reduced anatomy for veneering) vs full-contour mode
- Whole-bridge QC: single watertight solid, per-unit thickness, per-connector area, per-abutment margin fit

**Acceptance:** 3-unit posterior bridge on fixtures passes all gates; connector area gate blocks a 5 mm² posterior connector; pontic-gingiva relation matches configured relief within ±20 µm.

### Phase 7 — Export & Manufacturing Handoff

- Binary STL export (watertight, outward normals, mm units); optional PLY with color
- **Independent backend re-validation:** server loads exported bytes, re-runs every QC gate with the Node kernel; only then is the file released. Any mismatch between client and server QC = hard failure + bug report payload
- QC report: human-readable PDF-ready HTML + machine-readable JSON (all gate results, parameters used, material profile version, kernel version, journal hash) — the traceability document for the lab
- Case archive export/import (single file: scans + journal + settings) for support and inter-lab transfer

**Acceptance:** exported crown STL re-imports as watertight/manifold; QC JSON schema validated; tampered export bytes are rejected by re-validation; archive round-trip reproduces identical case state.

### Phase 8 — Polish & Hardening

- Full i18n pass (EN/HU/DE/ES), keyboard shortcuts + command palette, onboarding tour (pattern from Odontogram module)
- Performance pass *without* accuracy regression: worker-pool tuning, BVH caching, render LODs — golden files must remain byte-identical
- Crash-safe autosave/recovery, telemetry-free error reports (local log bundle)
- Security: local auth (single-user default), backend input validation on every route (Fastify schemas)
- Beta with 2–3 dental technicians; structured feedback loop

---

## 5. Repository Layout

```
dq-dental-cad/
├── apps/
│   ├── client/                 # React app
│   │   └── src/
│   │       ├── ui/             # React components (panels, wizard, dialogs) — NO geometry math here
│   │       ├── engine/         # SceneManager, ToolManager, CaseStore (imperative TS)
│   │       ├── state/          # zustand stores (UI-facing snapshots)
│   │       └── i18n/
│   └── server/                 # Fastify + Prisma + SQLite
├── packages/
│   ├── kernel/                 # ★ Float64 geometry core — pure TS, zero DOM/Three imports
│   │   └── src/{halfedge, curvature, geodesic, spline, sdf, offset, boolean, bvh, measure, undercut}/
│   ├── kernel-workers/         # Worker entrypoints + Comlink wiring (browser & Node)
│   ├── io/                     # STL/PLY parsers & writers (pure TS)
│   ├── cad-pipeline/           # Restoration stages (inner surface, anatomy, morphing, shell, QC gates)
│   ├── clinical-profiles/      # Material profile schemas + shipped defaults (JSON)
│   ├── tooth-library/          # Anatomy assets + loader
│   └── shared-types/           # CaseDocument, Operation, QcReport types (client+server)
├── test-fixtures/              # Git LFS: synthetic + real scan fixtures + golden outputs
├── docs/                       # ADRs, demo recordings, QC gate definitions
├── CLAUDE.md
└── PLAN.md
```

Dependency rule (enforced with eslint-plugin-boundaries): `ui → engine → kernel-workers → kernel`; `kernel` and `io` import nothing from upper layers, nothing from Three.js.

---

## 6. Accuracy & Reliability Strategy (cross-cutting)

These are non-negotiable invariants. CLAUDE.md repeats them as hard rules.

1. **Float64 kernel.** All coordinates, transforms, and intermediate math in the kernel and pipeline are Float64. Float32 appears only in render-copy buffers created at the engine boundary.
2. **Deterministic, versioned operations.** Same inputs + same params + same kernel version ⇒ bit-identical outputs. No `Math.random` without seeded RNG; no time-dependent logic; worker scheduling must not affect results (operations are pure functions of their inputs).
3. **Journal reproducibility.** Replaying a case journal reproduces every stage hash. CI replays fixture journals on every commit.
4. **QC gates block export.** Watertight, manifold, no self-intersections, min thickness, connector area, margin-fit deviation, seating penetration. Gates can be *acknowledged* (journaled, shown in report) but never silently skipped.
5. **Dual validation.** Client computes, server independently re-validates with the same versioned kernel before releasing files.
6. **Error bounds are documented.** Every approximating algorithm (SDF offset, marching cubes, decimated LODs) states its bound in code docs and surfaces it in the QC report where relevant.
7. **No silent data mutation.** Unit rescaling, repair, normal flips — all require user confirmation and are journaled.
8. **Testing pyramid:**
   - Property-based tests (fast-check) for kernel math (e.g. offset(offset(m, d), −d) ≈ m within bound)
   - Analytic golden tests (spheres, cylinders, tori with closed-form answers)
   - Golden-file regression on real fixtures (hash-compared)
   - Fuzzing for parsers (structured + random corpus)
   - E2E (Playwright): full crown/inlay/bridge design flows on fixtures, asserting QC JSON
   - Target: kernel/io/cad-pipeline ≥ 90% line coverage; every bug fix adds a regression fixture
9. **Regulatory posture (documented, not blocking):** design outputs are operator-verified proposals; the QC report + journal provide traceability. Keep an ADR on MDR/FDA classification implications before any commercial release; the architecture (journaling, dual validation, versioned profiles) is built to support a future QMS.

---

## 7. Non-Functional Requirements

- Handle meshes up to ~5 M triangles (full-arch scans) — streaming parse, worker-side storage, render LODs
- UI thread never blocked > 50 ms; all kernel jobs cancellable with progress
- Startup < 5 s; case open < 10 s for typical case (3 scans)
- Works fully offline; no external network calls at runtime
- Browser target: Chromium + Firefox latest; WebGL2 required; SharedArrayBuffer optional (fallback to transfer)

---

## 8. Milestone Summary

| Milestone | Phases | Outcome |
|---|---|---|
| M1 "Trustworthy viewer" | 0–1 | Load, inspect, measure, section any STL/PLY reliably |
| M2 "Kernel proven" | 2 | Geometry core with analytic-verified accuracy |
| M3 "Margin master" | 3 | Case setup, margin line, insertion axis on real preps |
| M4 "First crown" | 4 | End-to-end crown passing QC, exportable |
| M5 "Full restorative set" | 5–6 | Inlay/onlay + bridge |
| M6 "Lab-ready" | 7–8 | Manufacturing handoff, QC reports, beta feedback |

Suggested order of implementation inside every phase: kernel/pipeline code + tests first, UI tool second, e2e last.

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Boolean/offset robustness on dirty real-world scans | Mandatory intake repair + manifold-3d (guaranteed-manifold outputs) + gate re-validation; keep a corpus of "nasty" scans as fixtures |
| Margin auto-detection quality varies by scanner | Always editable spline; auto is a proposal, never final; collect failure cases into fixtures |
| WASM/worker memory ceilings on huge arches | Streaming, region-of-interest cropping for prep work, LFS-tested 5 M-triangle fixture in CI |
| Scope creep toward full exocad clone | Phase gates + this plan; new features require an ADR |
| Float64 → Three.js Float32 visual artifacts on far-from-origin coords | Re-center scene at case bbox centroid; render copies are local-frame |
| Tooth library licensing | Start with openly licensed/self-made anatomy set; document provenance per asset |

---

## 10. Future Roadmap (post-M6)

- Virtual articulator (static → semi-adjustable), dynamic occlusion (FGP)
- AI margin proposal (train on collected editable-margin corrections)
- Implant abutment & screw-retained workflows
- Telescope/bar constructions (ties into Odontogram state vocabulary)
- Integration: case handoff from DentalQuoteCreator (patient/quote link) and DQ-Dental-Techniq (lab worksheet ↔ CAD case)
- Intraoral scanner direct import (3Shape/Medit open formats)
- Printing/milling connectors (CAM handoff presets)
