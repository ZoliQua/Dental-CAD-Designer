# 🦷 DQ Dental CAD

**Standalone dental CAD web application for viewing intraoral scans (STL/PLY) and designing crowns, inlays/onlays and bridges.**

🇭🇺 *Magyar nyelvű leírás: [README.hu.md](README.hu.md)*

Part of the DQ ecosystem; runs standalone and is designed to be later integrated as a module alongside React-Odontogram-Modul and React-Dental-CBCT-Viewer.

> **Guiding principle: accuracy over speed.** Every geometric result must be clinically trustworthy. A long computation with a progress bar is acceptable; a silently wrong margin line is not.

> **Status: MVP feature-complete and beta-ready.** All planned phases (0–8) of [`PLAN.md`](./PLAN.md) are implemented — the full path from importing a scan through designing a restoration, running QC, and handing off to manufacturing, plus a hardening pass. Every result in this repository is **fixture-proven**: acceptance is demonstrated on synthetic, closed-form fixtures. Certification on real intraoral scans, a live multi-material picker, and a technician beta are the standing follow-ups. This is not a certified medical device (see [Disclaimer](#disclaimer)).

## Features

- **Import** — STL (binary + ASCII) and PLY (binary LE/BE + ASCII), with a mesh intake pipeline (vertex welding, degenerate-triangle removal, orientation fixing, statistics), mandatory unit confirmation (STL carries no units), and a hardened parser that rejects hostile/malformed files rather than hanging or crashing
- **Full 3D viewer** — orbit/pan/zoom, standard views, shading modes, wireframe, selection, scene tree; render-only decimated LOD copies keep the UI responsive without ever touching the Float64 data of record
- **Analysis tools** — point-to-point measurements (BVH-accelerated), surface-to-surface distance heatmaps, cross-sections with filled caps and SVG export
- **Mesh repair** — remove components, split non-manifold edges, fill small holes — always with explicit user confirmation, never silently
- **Geometry kernel** — halfedge topology, discrete curvature (mean, Gaussian, principal), geodesic paths, cubic splines constrained to the mesh surface, SDF offsets, marching cubes, and manifold-guaranteed booleans
- **Restoration design** — case setup with FDI charting; margin line (κ2 ridge auto-detection + a full manual editor); insertion axis with a live undercut heatmap; and the full design pipeline for **crowns, inlays/onlays, and bridges** (intaglio/cement-gap surface, anatomy placement, RBF morphing, shell boolean, freeform sculpting; per-abutment fit, pontic gingival interface, and area-gated connectors for bridges) — all driven by versioned, checksum-verified clinical material profiles
- **QC gates** — watertightness, manifoldness, self-intersections, minimum wall thickness, margin-fit deviation, seating penetration, connector cross-section, pontic relief, cusp coverage, seam dihedral. Gates block export; structural gates (watertight/manifold/self-intersection) can never be acknowledged away, and any soft-gate acknowledgment is journaled — never a silent bypass
- **Manufacturing export & handoff** — deterministic watertight binary STL (topology-verified outward normals, documented Float32 narrowing bound) and optional PLY; a **QC traceability document** (schema-validated JSON + PDF-ready HTML in four languages) recording every gate result, parameter, profile version, kernel version and journal hash; and a single-file **case archive** (scans + journal + settings) with an integrity manifest for support and inter-lab transfer
- **Independent server re-validation** — the backend re-parses the **exact exported bytes**, re-runs every QC gate with the Node kernel against server-resolved (registry-pinned) thresholds, and releases the file only on a clean pass; any client/server mismatch is a hard failure with a diagnostic bundle. Gates the server cannot recompute from the delivered bytes are disclosed as *client-attested*, never presented as a full-authority pass
- **Case persistence & recovery** — full design-step journal (undo/redo, reopen at any step), content-addressed immutable scan storage, and crash-safe local autosave with state-identical recovery after an unclean shutdown
- **Productivity & robustness** — keyboard shortcuts + a command palette on a single action registry, a first-run onboarding tour, a telemetry-free / PHI-free local error-report bundle, and local single-user authentication gating every mutating route

## Architecture

```
React UI shell (panels, i18n, theme)
        │  zustand snapshots
Engine (imperative TS — SceneManager / ToolManager / CaseStore, Three.js, Float32 render copies)
        │  Comlink RPC, transferable buffers
Geometry workers (Web Worker pool)
   ├─ kernel  — pure TypeScript, Float64: halfedge, curvature, geodesics, splines, BVH
   ├─ manifold-3d (WASM) — booleans, repair, guaranteed-manifold outputs
   └─ io      — STL/PLY parsing & serialization
        │  REST + WebSocket
Node.js backend (Fastify + Prisma + SQLite) — cases, files, tooth library,
independent export re-validation with the same kernel
```

### Repository layout

| Path | Contents |
|---|---|
| `apps/client/` | React UI + imperative engine (Three.js lives only here) |
| `apps/server/` | Fastify + Prisma + SQLite; export re-validation |
| `packages/kernel/` | Float64 geometry core — pure TS, no DOM, no Three.js |
| `packages/kernel-workers/` | Worker entrypoints (Comlink), browser & Node |
| `packages/io/` | STL/PLY parsers/writers — pure TS |
| `packages/cad-pipeline/` | Restoration stages + QC gates |
| `packages/clinical-profiles/` | Versioned material profiles (JSON, schema-checked) |
| `packages/shared-types/` | CaseDocument, Operation, QcReport |

## Getting started

### Prerequisites

- Node.js **>= 23.6** (see `engines.node` in `package.json`)
- [Git LFS](https://git-lfs.com/) — `test-fixtures/**/*.stl` and `*.ply` are stored via LFS; run `git lfs install` once, then clone normally (or `git lfs pull` if you cloned before installing LFS)

### Setup

```bash
git clone https://github.com/ZoliQua/React-Dental-Designer.git
cd React-Dental-Designer
npm install
npm run dev
```

`npm install` triggers `apps/server`'s `postinstall` (`prisma generate`). The server's SQLite dev database is bootstrapped automatically on first start: `npm run dev` creates `apps/server/.env` from `.env.example` if missing and runs `prisma migrate deploy` before the API starts listening — no manual migration step is needed on a fresh clone.

### Commands

```bash
npm run dev               # client + server + workers (Vite on 5173, API on 4100)
npm run build             # production build (all workspaces)
npm test                  # full Vitest suite (kernel, io, pipeline, server)
npm run test:kernel       # kernel-only, fastest loop for geometry work
npm run test:golden       # golden-file regression (requires test-fixtures via Git LFS)
npm run test:e2e          # Playwright design-flow tests (chromium)
npm run lint && npm run typecheck
```

Fixtures live in `test-fixtures/` (Git LFS). If golden tests fail with a "Git LFS pointer file" error, run `git lfs pull`. `npm run test:e2e` starts its own `npm run dev` instance unless one is already running on `http://localhost:5173`.

## Engineering principles

- **Float64 everywhere in the kernel.** Float32 exists only in render copies. Prep dies are ~10 mm objects with 50 µm features; chained Float32 operations accumulate visible error.
- **Determinism.** Same inputs + parameters + kernel version ⇒ bit-identical outputs. No unseeded randomness, no wall-clock time in computations.
- **Journaled operations.** Every destructive operation is recorded (name, parameters, input/output hashes); replaying the journal reproduces identical hashes, verified in CI.
- **QC gates block export.** Watertightness, manifoldness, self-intersections, minimum wall thickness, connector cross-section, margin-fit deviation, seating penetration, pontic relief, cusp coverage, seam dihedral. Soft gates can be acknowledged with a journaled warning; structural gates can never be acknowledged away — and nothing is ever silently bypassed.
- **Dual validation on the exact bytes.** The server re-parses the exported file, re-runs all QC gates with the Node kernel against registry-resolved thresholds, and releases only on a clean pass; a mismatch is a hard failure. Any gate not recomputable from the delivered bytes is disclosed as *client-attested*, never a full-authority pass.
- **Documented error bounds.** Every approximating algorithm (SDF offsets, marching cubes) documents its error bound and surfaces it in the QC report; measurement failures fail closed (a gate with no valid samples fails, it never passes on a sentinel).
- **No silent data mutation or data loss.** Unit rescale, mesh repair and normal flips require explicit confirmation and a journal entry; autosave/recovery and case saves are guarded against cross-case overwrite and unclean-shutdown loss.

See [`PLAN.md`](./PLAN.md) for phases, acceptance criteria and the clinical data model, and [`CLAUDE.md`](./CLAUDE.md) for the full engineering invariants.

## Roadmap

All planned phases are complete; the application is MVP feature-complete and beta-ready.

| Phase | Scope | Status |
|---|---|---|
| 0 | Foundation: monorepo, viewer shell, server, worker pool, manifold WASM, CI | ✅ done |
| 1 | Import & viewer (M1 "Trustworthy viewer") | ✅ done |
| 2 | Geometry kernel core: hashing, halfedge, curvature, geodesics, splines, offsets | ✅ done |
| 3 | Case setup, margin line, insertion axis (M3 "Margin master") | ✅ done |
| 4 | Crown design (M4 "First crown") | ✅ done |
| 5 | Inlay / onlay | ✅ done |
| 6 | Bridge (M6 "Multi-unit") | ✅ done |
| 7 | Export & manufacturing handoff (M7 "Handoff") | ✅ done |
| 8 | Polish & hardening | ✅ done |

**Standing follow-ups (not yet done):** certification on real intraoral scans (retraction-cord crown, cavity, multi-abutment bridge), a live multi-material picker, a true geometric self-intersection gate (currently a manifold-topology proxy, documented), and a 2–3 technician beta.

## Internationalization

UI languages: English, Hungarian, German, Spanish. Dark/light theme via CSS custom properties. Tooth numbering uses the FDI scheme (11–48).

## Disclaimer

This software is under active development and is not a certified medical device. Outputs must be reviewed by a qualified dental professional before clinical or manufacturing use.
