# 🦷 DQ Dental CAD

**Standalone dental CAD web application for viewing intraoral scans (STL/PLY) and designing crowns, inlays/onlays and bridges.**

🇭🇺 *Magyar nyelvű leírás: [README.hu.md](README.hu.md)*

Part of the DQ ecosystem; runs standalone and is designed to be later integrated as a module alongside React-Odontogram-Modul and React-Dental-CBCT-Viewer.

> **Guiding principle: accuracy over speed.** Every geometric result must be clinically trustworthy. A long computation with a progress bar is acceptable; a silently wrong margin line is not.

## Features

- **Import / export** — STL (binary + ASCII) and PLY (binary LE/BE + ASCII), with a mesh intake pipeline (vertex welding, degenerate-triangle removal, orientation fixing, statistics) and mandatory unit confirmation (STL carries no units)
- **Full 3D viewer** — orbit/pan/zoom, standard views, shading modes, wireframe, selection, scene tree
- **Analysis tools** — point-to-point measurements (BVH-accelerated), surface-to-surface distance heatmaps, cross-sections with filled caps and SVG export
- **Mesh repair** — remove components, split non-manifold edges, fill small holes — always with explicit user confirmation, never silently
- **Geometry kernel** — halfedge topology, discrete curvature (mean, Gaussian, principal), geodesic paths, cubic splines constrained to the mesh surface (margin-line editing)
- **Restoration design** *(in progress)* — margin line, insertion axis + undercut analysis, crown/inlay/onlay/bridge design driven by versioned clinical material profiles
- **Manufacturing export** — watertight binary STL plus a machine-readable QC report; the server re-validates every export independently
- **Case persistence** — full design-step journal (undo/redo, reopen at any step), content-addressed immutable scan storage

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
- **QC gates block export.** Watertightness, manifoldness, self-intersections, minimum wall thickness, connector cross-section, margin-fit deviation, seating penetration. Gates can be acknowledged with a journaled warning — never silently bypassed.
- **Dual validation.** The server re-runs all QC gates on the exact exported bytes with the Node kernel before releasing any file.
- **Documented error bounds.** Every approximating algorithm (SDF offsets, marching cubes) documents its error bound and surfaces it in the QC report.

See [`PLAN.md`](./PLAN.md) for phases, acceptance criteria and the clinical data model, and [`CLAUDE.md`](./CLAUDE.md) for the full engineering invariants.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Foundation: monorepo, viewer shell, server, worker pool, manifold WASM, CI | ✅ done |
| 1 | Import & viewer (M1 "Trustworthy viewer") | ✅ done |
| 2 | Geometry kernel core: hashing, halfedge, curvature, geodesics, splines, offsets | 🔨 in progress |
| 3 | Case setup, margin line, insertion axis | ⏳ planned |
| 4 | Crown design | ⏳ planned |
| 5 | Inlay / onlay | ⏳ planned |
| 6 | Bridge | ⏳ planned |
| 7 | Export & manufacturing handoff | ⏳ planned |
| 8 | Polish & hardening | ⏳ planned |

## Internationalization

UI languages: English, Hungarian, German, Spanish. Dark/light theme via CSS custom properties. Tooth numbering uses the FDI scheme (11–48).

## Disclaimer

This software is under active development and is not a certified medical device. Outputs must be reviewed by a qualified dental professional before clinical or manufacturing use.
