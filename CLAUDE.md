# CLAUDE.md — DQ-Dental-CAD

Standalone dental CAD application: STL/PLY import/viewing and design of crowns, inlays/onlays, and bridges. React + TypeScript frontend, Node.js (Fastify) backend, Three.js rendering, Float64 TS + `manifold-3d` WASM geometry kernel.

**Read `PLAN.md` before implementing anything.** It defines phases, acceptance criteria, the data model, and clinical parameters. Work phase by phase; do not start a phase before the previous phase's acceptance criteria pass.

## The one rule that overrides everything

**Accuracy over speed. This is medical-adjacent software.** A slower correct algorithm always beats a faster approximate one. If you must approximate (SDF offsets, marching cubes), the error bound must be documented in code and surfaced in the QC report. Never trade precision for FPS in the kernel — performance work happens only in rendering and only via LOD copies.

## Commands

```bash
npm run dev              # client + server + workers (Vite on 5173, API on 4100)
npm run build            # production build (all workspaces)
npm test                 # full Vitest suite (kernel, io, pipeline, server)
npm run test:kernel      # kernel-only, fastest loop for geometry work
npm run test:golden      # golden-file regression (requires test-fixtures via Git LFS)
npm run test:e2e         # Playwright design-flow tests
npm run lint && npm run typecheck
```

Fixtures live in `test-fixtures/` (Git LFS). If golden tests fail with missing files, run `git lfs pull`.

## Repository map

```
apps/client/src/ui/        React components ONLY — zero geometry math here
apps/client/src/engine/    SceneManager, ToolManager, CaseStore (imperative, non-React)
apps/server/               Fastify + Prisma + SQLite; export re-validation
packages/kernel/           ★ Float64 geometry core — pure TS, no DOM, no Three.js imports
packages/kernel-workers/   Worker entrypoints (Comlink), browser & Node
packages/io/               STL/PLY parsers/writers — pure TS
packages/cad-pipeline/     Restoration stages + QC gates
packages/clinical-profiles/ Material profiles (JSON, versioned, schema-checked)
packages/shared-types/     CaseDocument, Operation, QcReport
```

Layer rule (lint-enforced): `ui → engine → kernel-workers → kernel`. `kernel` and `io` import nothing from upper layers and nothing from Three.js. Violating this is always wrong — fix the design, not the lint rule.

**Import extension convention.** Only files actually reachable from the Node worker entry's own import closure — `kernel-workers/src/worker-entry.node.ts` → `jobs/registry.ts` → `kernel`'s and `io`'s internal relative imports — MUST use literal `.ts` extensions in their own relative imports (`allowImportingTsExtensions` in `tsconfig.base.json`, paired with Node's native TS-stripping loader). This is NOT "every file in the `kernel`/`kernel-workers` packages": `kernel-workers/src/pool.ts`, `index.ts`, and `worker-entry.browser.ts` are never loaded by the Node native loader (they run bundled, browser-side, or are pure exports consumed by bundlers), so they legitimately keep `.js`-suffix ESM-style relative imports — the usual TS convention for compiled output — like everywhere else in the repo. Why the split matters: Node's native loader resolves relative specifiers literally with no `.js` → `.ts` mapping, so a worker-loaded file importing `./foo.js` would fail to resolve when only `foo.ts` exists on disk; a file outside that closure has no such constraint and should just follow the normal convention.

## Hard invariants — never break these

1. **Float64 in the kernel.** All coordinates, transforms, and math in `kernel/`, `io/`, `cad-pipeline/` use Float64. `Float32Array` may only appear in `engine/` render copies. Adding a `Float32Array` to the kernel is a bug even if tests pass.
2. **Determinism.** Same inputs + params + kernel version ⇒ bit-identical outputs. No unseeded randomness, no `Date.now()` in computations, no results dependent on worker scheduling. Every op is a pure function of its inputs.
3. **Journal everything.** Every destructive operation appends an `Operation` (name, params, input/output hashes) to the case journal. Replaying the journal must reproduce identical hashes — CI checks this. If your feature mutates geometry and doesn't journal, it's incomplete.
4. **QC gates block export.** Watertight, manifold, no self-intersections, min wall thickness, connector cross-section, margin-fit deviation, seating penetration. Gates may be *acknowledged with a warning* (journaled, in the report) — never silently bypassed. Never weaken a gate threshold to make a test pass.
5. **No silent data mutation.** Unit rescale, mesh repair, normal flips → explicit user confirmation + journal entry.
6. **Dual validation stays dual.** The server re-validates exports independently. Never "optimize" this into trusting the client result.
7. **Clinical defaults live in `clinical-profiles/` only.** Never hardcode a gap, thickness, or connector area in pipeline code. See PLAN.md §3 for the parameter table.

## Geometry work — how to do it right

- New kernel algorithm = tests first: property-based (fast-check) + analytic golden case (sphere/cylinder/torus with closed-form answer) before any real-scan fixture.
- Every approximating algorithm documents its error bound in TSDoc (`@errorBound`) and, where user-relevant, reports it in `QcReport`.
- Booleans and repairs go through the `manifold-3d` wrapper in `kernel/src/boolean/` — never call raw manifold from pipeline code. The wrapper validates inputs (watertight) and re-validates outputs.
- Halfedge topology: run `assertValidTopology()` in tests and debug builds after any structural edit.
- Units are **mm** everywhere internally; display formats µm where clinically meaningful (gaps, deviations). 1 µm display resolution.
- Meshes are immutable values: operations return new meshes (hash-addressed); never mutate a stored mesh buffer in place.
- Heavy work (> ~10 ms) belongs in a worker with progress + cancellation. The UI thread must never block > 50 ms.

## Testing expectations

- `kernel/`, `io/`, `cad-pipeline/`: ≥ 90% line coverage; PRs that lower it need justification.
- Every bug fix adds a regression fixture (mesh + expected output hash) to `test-fixtures/`.
- Parser changes: run the fuzz corpus (`npm run test:fuzz`).
- Golden hashes change ONLY with a deliberate kernel version bump + changelog entry explaining the numerical difference. A "small numeric diff" in golden files is a red flag — investigate, don't regenerate.

## Frontend conventions

- React is the shell; the engine is imperative TS (same pattern as React-Odontogram-Modul / React-Dental-CBCT-Viewer). Don't move engine state into React state; UI subscribes to zustand snapshots published by the engine.
- Three.js objects live only in `engine/`. Render meshes are Float32 local-frame copies re-centered at the case bbox centroid (float precision far from origin).
- i18n: EN/HU/DE/ES. No hardcoded UI strings; keys in `apps/client/src/i18n/`. Dark/light theme via CSS custom properties.
- TS `strict: true`, no `any` (use `unknown` + narrowing), no non-null assertions in kernel/pipeline code.

## Backend conventions

- Fastify routes always define JSON schemas (validation + serialization).
- Prisma + SQLite; migrations via `npx prisma migrate dev`. Keep the schema portable to PostgreSQL (no SQLite-only features).
- Scan files are content-addressed (SHA-256) and immutable once stored.
- Export endpoint: re-run all QC gates with the Node kernel on the exact exported bytes before releasing the file. Client/server QC mismatch = hard error with a diagnostic bundle.

## Domain vocabulary (use these terms in code)

margin line (finish line), prep/die, insertion axis, undercut, cement gap / spacer, marginal gap, antagonist, occlusal/proximal contact, pontic, connector, abutment, full-contour vs framework, FDI numbering (`FdiTooth` type; 11–48). Tooth numbering utilities follow the conventions of React-Odontogram-Modul.

## Common pitfalls

- STL has no units — bbox heuristic + mandatory user confirmation; never silently rescale.
- PLY property order/types vary by scanner; parse from the header, never assume layout.
- STL files routinely contain duplicate vertices, flipped normals, self-intersections — everything goes through the intake pipeline before any kernel op.
- Marching-cubes offsets at too coarse a pitch destroy margin detail — default 20 µm pitch for die-sized inputs; pitch is a journaled parameter.
- Boolean on non-watertight input: the wrapper rejects it — repair first, don't bypass.

## Definition of done (any task)

1. Tests written and green (`npm test`), typecheck + lint clean
2. Invariants above respected (esp. Float64, journaling, gates)
3. Golden files unchanged, or changed with kernel version bump + changelog
4. Error bounds documented for any approximation
5. UI strings i18n'd in all 4 languages
6. PLAN.md acceptance criteria for the current phase still pass
