# DQ Dental CAD

Standalone dental CAD application for STL/PLY import and design of crowns, inlays/onlays, and bridges — React/TypeScript frontend, Fastify backend, Three.js rendering, and a Float64 TypeScript + `manifold-3d` (WASM) geometry kernel.

See [`PLAN.md`](./PLAN.md) for phases, acceptance criteria, and the clinical data model, and [`CLAUDE.md`](./CLAUDE.md) for the engineering invariants (Float64 kernel, layer boundaries, determinism, journaling, QC gates).

## Prerequisites

- Node.js **>= 23.6** (see `engines.node` in `package.json`)
- [Git LFS](https://git-lfs.com/) — `test-fixtures/**/*.stl` and `*.ply` are stored via LFS; run `git lfs install` once, then clone normally (or `git lfs pull` if you cloned before installing LFS)

## Setup

```bash
git clone <repo-url>
cd dq-dental-cad
npm install
npm run dev
```

`npm install` triggers `apps/server`'s `postinstall` (`prisma generate`). The server's SQLite dev database is bootstrapped automatically the first time it starts: `npm run dev` (via `apps/server`'s `predev`/`dev` scripts) creates `apps/server/.env` from `.env.example` if missing and runs `prisma migrate deploy` before the API starts listening — no manual migration step is required on a fresh clone.

## Commands

```bash
npm run dev               # client + server + workers (Vite on 5173, API on 4100)
npm run build              # production build (all workspaces)
npm test                   # full Vitest suite (kernel, io, pipeline, server)
npm run test:kernel        # kernel-only, fastest loop for geometry work
npm run test:golden        # golden-file regression (requires test-fixtures via Git LFS)
npm run test:e2e           # Playwright design-flow smoke test (chromium)
npm run lint && npm run typecheck
```

Fixtures live in `test-fixtures/` (Git LFS). If golden tests fail with a "Git LFS pointer file" error, run `git lfs pull`.

`npm run test:e2e` starts its own `npm run dev` instance (see `playwright.config.ts`) unless one is already running on `http://localhost:5173`, in which case it reuses it (local iteration only — CI always starts fresh).

## Phase 0 status

Phase 0 (foundation) is **complete**: monorepo scaffold, strict TS + lint boundaries, client/server shells wired over the `/api` proxy, the worker pool (mesh buffer + `manifold-3d` WASM round-trips, both Node and browser), Git LFS fixture pipeline (synthetic + anonymized real-scan fixtures), and this Playwright e2e smoke + CI workflow. Phase 0 acceptance (`PLAN.md`): `npm run dev` boots UI+server, a worker round-trips a mesh buffer, CI is green — verified locally and enforced in `.github/workflows/ci.yml`.
