# Phase 0 — Foundation: Execution Plan

Decomposition of PLAN.md Phase 0 into dispatchable tasks. Executed on branch `phase-0-foundation`.

**Phase acceptance (from PLAN.md):** `npm run dev` boots UI+server; a worker round-trips a mesh buffer; CI green.

## Global Constraints (bind every task)

- **Float64 in the kernel.** All coordinates and math in `packages/kernel`, `packages/io`, `packages/cad-pipeline` use Float64. `Float32Array` may only appear in `apps/client/src/engine/` render copies — with one documented exception: the `manifold-3d` WASM boundary converts Float64→Float32; the wrapper documents this as an error bound.
- **Layer rule (lint-enforced):** `ui → engine → kernel-workers → kernel`. `kernel` and `io` import nothing from upper layers and nothing from `three`.
- **Determinism:** no unseeded randomness, no `Date.now()` in computations. Fixture generators must be fully deterministic (stable output hashes).
- **TypeScript `strict: true`**, no `any` (use `unknown` + narrowing), ESM everywhere (`"type": "module"`).
- **Ports:** Vite dev server **5173**, Fastify API **4100**.
- **Units:** mm internally.
- **i18n:** no hardcoded UI strings; keys exist in EN/HU/DE/ES.
- **Package scope:** `@dqcad/*` for workspace packages. Root package name: `dq-dental-cad`.
- **No clinical defaults hardcoded** outside `packages/clinical-profiles`.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Task 1 — Monorepo scaffold, tooling, shared types

Create the npm-workspaces monorepo skeleton with strict TS, ESLint (flat config) + Prettier, Vitest, and the initial shared type model.

**Deliverables:**

1. Root `package.json`: name `dq-dental-cad`, `private: true`, `"type": "module"`, `workspaces: ["apps/*", "packages/*"]`, `engines.node: ">=22"`. Root scripts:
   - `lint`: `eslint .`
   - `format`: `prettier --write .` / `format:check`
   - `typecheck`: `tsc --noEmit` in every workspace with a tsconfig (`npm run typecheck --workspaces --if-present` + per-workspace `typecheck` scripts)
   - `test`: `vitest run` (root config discovers all workspace tests)
   - `test:kernel`: `vitest run --project kernel`
2. `tsconfig.base.json`: `strict: true`, `noUncheckedIndexedAccess: true`, `target: "ES2022"`, `module: "ESNext"`, `moduleResolution: "bundler"`, `verbatimModuleSyntax: true`. Every workspace extends it.
3. Workspace package skeletons (each: `package.json` with name `@dqcad/<name>`, `"type": "module"`, `exports` pointing at `src/index.ts`, own `tsconfig.json`, `src/index.ts`):
   - `packages/shared-types`, `packages/kernel`, `packages/kernel-workers`, `packages/io`, `packages/cad-pipeline`, `packages/clinical-profiles`, `packages/tooth-library`
   - `apps/client` and `apps/server` are created as **empty placeholder dirs with package.json only** (filled by Tasks 2–3); give each a no-op `typecheck` for now if no tsconfig yet, or minimal tsconfig + empty `src/index.ts`.
4. `packages/shared-types/src/`: initial domain types per PLAN.md §2.2 (these are type declarations only, no logic):
   - `FdiTooth` — template-literal-safe union of valid FDI numbers 11–18, 21–28, 31–38, 41–48 (literal union type).
   - `Vec3 = readonly [number, number, number]`.
   - `MeshRole = 'upperJaw' | 'lowerJaw' | 'prepDie' | 'antagonist' | 'situ' | 'gingiva'`.
   - `MeshAsset { id: string; contentHash: string; name: string; unit: 'mm'; triangleCount: number; }`
   - `SceneNode { id: string; meshId: string; role: MeshRole; transform: readonly number[]; /* 16, column-major */ visible: boolean; opacity: number; }`
   - `MarginLine { vertexAnchors: readonly number[]; controlPoints: readonly Vec3[]; closed: boolean; }`
   - `RestorationType = 'crown' | 'inlay' | 'onlay' | 'bridge'`.
   - `RestorationParams { cementGapMm: number; marginalGapMm: number; spacerStartMm: number; minWallThicknessMm: number; proximalContactPenetrationMm: number; occlusalContactMm: number; }`
   - `Restoration { id: string; type: RestorationType; teeth: readonly FdiTooth[]; marginLines: Partial<Record<FdiTooth, MarginLine>>; insertionAxis: Vec3; params: RestorationParams; stages: { innerSurface?: string; anatomyPlacement?: string; morphState?: string; finalMesh?: string; }; qc: QcReport | null; }`
   - `Operation { id: string; name: string; params: Readonly<Record<string, unknown>>; inputHashes: readonly string[]; outputHashes: readonly string[]; kernelVersion: string; timestamp: string; }`
   - `QcGateResult { gate: string; passed: boolean; acknowledged: boolean; value: number | null; threshold: number | null; unit: string | null; message: string; }`
   - `QcReport { gates: readonly QcGateResult[]; passed: boolean; kernelVersion: string; profileVersion: string; journalHash: string; }`
   - `CaseSettings { materialProfileId: string; profileVersion: string; }`
   - `CaseDocument { id: string; schemaVersion: 1; createdAt: string; patientRef?: string; meshes: readonly MeshAsset[]; scene: readonly SceneNode[]; restorations: readonly Restoration[]; history: readonly Operation[]; settings: CaseSettings; }`
   - Unit test: a `.test.ts` that constructs a minimal valid `CaseDocument` literal (compile-time check) and asserts a couple of structural facts at runtime.
5. ESLint 9 flat config (`eslint.config.js`) with `typescript-eslint` recommended-type-checked *not* required — use `recommended`; plus `eslint-plugin-boundaries` enforcing:
   - element types: `ui` (apps/client/src/ui), `engine` (apps/client/src/engine), `state` (apps/client/src/state), `kernel-workers` (packages/kernel-workers), `kernel` (packages/kernel), `io` (packages/io), `cad-pipeline` (packages/cad-pipeline), `shared-types` (packages/shared-types)
   - allowed: `ui → engine, state, shared-types`; `engine → kernel-workers, state, shared-types`; `state → shared-types`; `kernel-workers → kernel, io, shared-types`; `cad-pipeline → kernel, io, shared-types`; `kernel → shared-types`; `io → shared-types`
   - plus `no-restricted-imports` of `three` inside `packages/kernel`, `packages/io`, `packages/cad-pipeline`.
   - `@typescript-eslint/no-explicit-any: error`.
6. Vitest 3 root config using `projects` so each package's tests run under a named project (`kernel`, `shared-types`, `kernel-workers`, `io`, `server`, `client`).
7. `.gitignore` (node_modules, dist, build, *.db, .env*, .superpowers/, playwright-report, test-results, coverage), `.prettierrc.json`, `.editorconfig`.
8. `npm install` succeeds; `npm run lint`, `npm run typecheck`, `npm test` all green.

**Not in scope:** any geometry code, client UI, server routes.

**Verify:** `npm run lint && npm run typecheck && npm test` exit 0. Commit.

---

## Task 2 — Client app shell (Vite + React + TS strict)

Create `apps/client`: Vite + React 18 app shell with zustand, i18n (EN/HU/DE/ES), dark/light theme, and a minimal imperative engine layer with a Three.js placeholder viewport.

**Deliverables:**

1. Vite app on port **5173** (`server.port: 5173, strictPort: true`), React 18, TS strict (extends `tsconfig.base.json` with `jsx: "react-jsx"`, DOM libs). Proxy `/api` → `http://localhost:4100`.
2. Directory layout per PLAN.md §5: `src/ui/`, `src/engine/`, `src/state/`, `src/i18n/`.
3. i18n with `i18next` + `react-i18next`; resource files `src/i18n/{en,hu,de,es}.json` with keys used by the shell (app title "DQ Dental CAD", theme toggle, language picker labels, status bar strings, worker smoke-test strings). Language picker in the header. No hardcoded UI strings in components.
4. Theme: CSS custom properties on `:root[data-theme='dark'|'light']`, toggle button, persisted in `localStorage`, default dark.
5. `src/engine/SceneManager.ts` — imperative TS class (NO React imports): creates a Three.js `WebGLRenderer`, perspective camera, `OrbitControls`, a neutral grid + hemisphere light placeholder scene, handles resize via `ResizeObserver`, `dispose()`. Mounted by a thin `ui/Viewport.tsx` component via `useRef`+`useEffect`. Three.js objects appear ONLY under `src/engine/`.
6. `src/state/appStore.ts` — zustand store for UI snapshot state (theme, language, engineReady flag).
7. App shell layout: header (title, language picker, theme toggle), left sidebar placeholder (scene tree, i18n'd "empty" state), central viewport, status bar showing engine ready state.
8. Client `dev` script (`vite`), `build` (`tsc --noEmit && vite build`), `typecheck`, wired into root scripts. Root `dev` may temporarily run client only (Task 3 adds concurrently).
9. Vitest project `client`: a smoke test for the zustand store + an i18n test asserting all 4 locales have identical key sets.

**Verify:** `npm run dev --workspace apps/client` serves on 5173 and renders the shell (verify with `curl -s localhost:5173 | grep -i root` at minimum); `npm run lint && npm run typecheck && npm test` green. Commit.

---

## Task 3 — Server (Fastify + Prisma + SQLite) and combined dev script

Create `apps/server` and make root `npm run dev` boot client+server together.

**Deliverables:**

1. Fastify 5 server on port **4100**, `@fastify/cors` allowing the Vite origin. Entry `src/index.ts`, app factory `src/app.ts` (exported for tests, listen only in index).
2. Every route defines a JSON schema (validation + serialization):
   - `GET /api/health` → `{ status: 'ok', version: string, kernelVersion: string }` (version from package.json import, kernelVersion hardcoded `'0.0.0'` constant in `@dqcad/kernel` `KERNEL_VERSION` export).
   - `GET /api/cases` → list of `{ id, name, createdAt, updatedAt, schemaVersion }`.
   - `POST /api/cases` body `{ name: string }` → creates an empty case row, returns the record. Document JSON stored as string column containing a minimal valid `CaseDocument`.
3. Prisma 6 + SQLite (`prisma/schema.prisma`): model `Case { id String @id @default(uuid()); name String; schemaVersion Int; documentJson String; createdAt DateTime @default(now()); updatedAt DateTime @updatedAt }`. No SQLite-only features. DB file `apps/server/prisma/dev.db`, git-ignored. Migration committed. `DATABASE_URL` via `.env` (git-ignored) + `.env.example` committed.
4. Server scripts: `dev` (`tsx watch src/index.ts`), `typecheck`, `test`. Prisma generate hooked into `postinstall` or `dev`/`test` pretasks so a fresh clone works.
5. Root `dev` script: `concurrently -k "npm:dev --workspace apps/server" "npm:dev --workspace apps/client"` (names/colors welcome). Root `build` builds all workspaces.
6. Vitest project `server` using `app.inject()` (no listening socket): health returns ok + correct shape; POST/GET cases round-trip; invalid POST body (missing name) → 400.

**Verify:** `npm run dev` boots both (client 5173 answers, `curl -s localhost:4100/api/health` returns ok JSON); tests green; lint+typecheck green. Commit.

---

## Task 4 — Worker pool infrastructure (Comlink, transferables, cancellation, progress)

Create `packages/kernel-workers`: a worker pool that runs geometry jobs off the UI thread, in both browser (Web Worker) and Node (worker_threads), with transferable buffers, progress events, and cancellation.

**Deliverables:**

1. Dependencies: `comlink`. Node side uses `worker_threads` + Comlink's node adapter; browser side `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })` (Vite-compatible).
2. `src/jobs.ts` — job registry, pure functions. Initial jobs:
   - `echoMesh(payload: { positions: Float64Array; indices: Uint32Array })` → returns the same arrays (moved back via transfer). Purpose: acceptance round-trip.
   - `longTask(payload: { iterations: number }, ctx)` → loops, calls `ctx.progress(fraction)` every chunk, checks `ctx.cancelled()` and aborts with a `JobCancelledError`. Deterministic result (e.g. running sum).
3. `src/pool.ts` — `WorkerPool`:
   - `constructor(opts?: { size?: number })` default `min(4, max(1, availableParallelism - 1))`.
   - `run<J>(jobName, payload, opts?: { transfer?: Transferable[]; onProgress?: (f: number) => void; signal?: AbortSignal })` → `Promise<Result>`; rejects with `JobCancelledError` on abort.
   - FIFO queue when all workers busy; workers reused; `destroy()` terminates all.
   - Cancellation: `signal` abort → notify worker (Comlink proxy or a shared cancellation flag via `SharedArrayBuffer` when available, fallback: cooperative flag message). Worker checks between chunks — cooperative cancellation is acceptable and must be documented.
4. `src/transfer.ts` — helpers: `meshBuffers(positions, indices)` returns `{ payload, transfer }` lists; asserts Float64Array for positions (kernel rule).
5. Environment split: `src/worker-entry.browser.ts` and `src/worker-entry.node.ts` sharing `jobs.ts`; pool picks entry by environment detection (document how Vite resolves the browser entry).
6. Tests (vitest, Node worker_threads path):
   - round-trip: `echoMesh` returns byte-identical Float64/Uint32 buffers (compare via hash or elementwise), and buffers were actually transferred (source `byteLength === 0` after post).
   - progress: `longTask` reports monotonically increasing fractions ending at 1.
   - cancellation: aborting mid-run rejects with `JobCancelledError` and the worker is reusable afterwards.
   - queueing: more jobs than workers all complete.
7. Client wiring (acceptance criterion "worker round-trips a mesh buffer"): a small dev panel in the client status bar — button (i18n'd) that generates a deterministic 1k-triangle mesh buffer, round-trips it through the browser pool, verifies byte-identity, shows ✓/✗ + triangle count. Engine layer owns the pool instance (`engine/workers.ts`); UI only calls through it.

**Verify:** `npm test` green incl. new project; `npm run dev` → clicking the smoke button shows ✓. Lint/typecheck green. Commit.

---

## Task 5 — manifold-3d WASM integration (Node + browser worker)

Integrate the `manifold-3d` WASM geometry library behind a kernel wrapper, working in both Node and the browser worker.

**Deliverables:**

1. Dependency `manifold-3d@^3` in `packages/kernel`.
2. `packages/kernel/src/boolean/manifold.ts`:
   - lazy singleton `initManifold(): Promise<ManifoldToplevel>` (WASM instantiation once per thread/worker).
   - `IndexedMesh` kernel type: `{ positions: Float64Array; indices: Uint32Array }` (defined in `packages/kernel/src/mesh/types.ts`).
   - `union(a, b)`, `subtract(a, b)`, `intersect(a, b)` — convert `IndexedMesh` (Float64) → manifold `Mesh` (Float32), run op, convert back to Float64.
   - **TSDoc `@errorBound`** on the converters: coordinates pass through Float32 at this boundary (~1e-7 relative error at mm scale); documented per PLAN.md §6.6.
   - Input validation: constructing a `Manifold` from a non-watertight mesh throws — surface manifold's status as a typed `NonManifoldInputError`.
   - `volume(mesh)` and `surfaceArea(mesh)` helpers via manifold properties (used by tests and later QC gates).
3. `packages/kernel/src/index.ts` exports `KERNEL_VERSION = '0.0.0'` (Task 3 references it) and the boolean API.
4. Kernel-workers job `manifoldSmoke()` → builds two overlapping unit cubes (offset 0.5 on x), unions them, returns `{ volume, expected: 1.5 }` — proves WASM loads inside the browser worker AND node worker.
5. Tests (vitest project `kernel`):
   - union of two axis-aligned overlapping cubes: volume == analytic within 1e-6 (integer-friendly coordinates → near-exact).
   - subtract: cube minus half-overlapping cube volume correct.
   - two disjoint spheres union: volume ≈ 2× single sphere volume (icosphere generator util allowed in test).
   - non-watertight input (open box, one face removed) → `NonManifoldInputError`.
   - `echoMesh`-style determinism: running the same union twice yields identical output hashes.
6. Client dev panel from Task 4 extended: second smoke line runs `manifoldSmoke` in the browser worker and displays volume ✓/✗ (i18n'd).

**Verify:** kernel tests green in Node; `npm run dev` → manifold smoke shows ✓ in browser. Lint/typecheck green. Commit.

---

## Task 6 — Test-data pipeline (synthetic fixtures + Git LFS)

Deterministic synthetic test meshes with analytic ground truth, checked in via Git LFS, plus generation tooling.

**Deliverables:**

1. `scripts/generate-fixtures.ts` (root `scripts/`, run with `tsx`), fully deterministic (no randomness, no timestamps in file content). Generates into `test-fixtures/synthetic/`:
   - `sphere-r5.stl` — icosphere radius 5 mm, 4 subdivisions.
   - `cylinder-r3-h8.stl` — radius 3, height 8, 128 segments, capped.
   - `torus-R5-r2.stl` — major 5, minor 2, 128×64 segments.
   - `boolean-pair-a.stl` / `boolean-pair-b.stl` — two spheres radius 3, centers 3 mm apart (known lens intersection volume).
   - Each mesh gets a JSON sidecar `<name>.expected.json`: `{ analyticVolumeMm3, analyticAreaMm2, bbox: {min, max}, sha256 }` (volume/area from closed-form formulas; note icosphere volume is the analytic *mesh* volume is NOT the sphere volume — store the sphere formula value AND a `meshVolumeToleranceFraction` reflecting tessellation, computed from subdivision level; document the reasoning in the script).
   - Binary STL writer implemented inside the script (little-endian, 80-byte header `DQCAD synthetic fixture`, outward normals) — `packages/io` gets the real parsers in Phase 1; this script-local writer is test tooling and must say so in a comment.
2. Stand-in for the missing prep-die scan in `test-fixtures/standin-scans/`: one procedural deterministic mesh `standin-prep-die.stl` (truncated cone with shoulder margin, ~10 mm). `README.md` stating: this is NOT a real scan; real arch/antagonist fixtures come from Task 8; a real prep-die/crown-prep case is still needed from the project owner before Phase 3 acceptance.
3. Git LFS: `.gitattributes` tracking `test-fixtures/**/*.stl` and `*.ply` via LFS; `git lfs install` run; fixtures committed as LFS objects.
4. Root script `fixtures:generate`: regenerates; `test:golden`: vitest project `golden` that (a) re-runs generators into a temp dir and asserts SHA-256 equality with the checked-in files (determinism + integrity), (b) loads each STL with a minimal script-local reader and checks triangle count and bbox against sidecar.
5. CI note: golden tests must fail with a clear message (not crash) if LFS files are missing (pointer-file detection).

**Verify:** `npm run fixtures:generate` idempotent (`git status` clean after second run); `npm run test:golden` green; `git lfs ls-files` lists the fixtures. Lint/typecheck green. Commit.

---

## Task 7 — Playwright e2e smoke + CI workflow + phase acceptance

Wire end-to-end smoke testing and CI; verify the whole Phase 0 acceptance.

**Deliverables:**

1. Playwright (`@playwright/test`) at root, config `playwright.config.ts`: chromium project only, `webServer` starts `npm run dev` (reuse existing server locally), baseURL `http://localhost:5173`.
2. `e2e/smoke.spec.ts`:
   - app shell renders (header title visible);
   - worker smoke button → ✓ result (mesh buffer round-trip in real browser);
   - manifold smoke line shows ✓ (WASM in browser worker);
   - `GET /api/health` through the Vite proxy returns ok.
3. Root script `test:e2e`: `playwright test`.
4. `.github/workflows/ci.yml`: on push/PR; jobs: checkout with `lfs: true`, Node 24, `npm ci`, `npx prisma generate` (if not automatic), then `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:golden`, then e2e smoke (`npx playwright install --with-deps chromium`, `npm run test:e2e`). Cache npm.
5. `README.md` at root: project one-liner, prerequisites (Node ≥22, git-lfs), commands table matching CLAUDE.md, Phase 0 status note.
6. Run the full local acceptance: `npm run typecheck && npm run lint && npm test && npm run test:golden && npm run test:e2e` — all green, and document the outputs in the report.

**Verify:** all commands above exit 0 locally. Commit.

---

## Task 8 — Real scan fixture import (anonymized)

Executed between Task 6 and Task 7. Two real cases (Shining 3D scanner, exocad export folders, with bite scans, upper+lower jaw) live in `scans/` (git-ignored — filenames, PLY header comments, and `.dentalProject` XML contain patient-identifying data). Import them into `test-fixtures/` as anonymized LFS fixtures. These case folders are the canonical input shape the app itself must accept later.

**Source folder anatomy (exocad export):** `<date>_<id>_<PatientName>_exo/` containing `…-UpperJaw.{stl,ply,obj}`, `…-LowerJaw.{stl,ply,obj}`, `…-TotalJaw0.{stl,ply,obj}` and `…-TotalJaw1.{stl,ply,obj}` (bite scans), `.mtl`+`.jpg` textures, `<name>.dentalProject` (XML: patient/practice metadata — PHI), `<name>.matrix4` (XML 4×4 occlusion alignment matrix — not PHI). PLY files are `binary_little_endian 1.0`; jaw PLYs carry `comment TextureFile <original patient filename>` headers. STL are binary.

**Deliverables:**

1. `scripts/import-scan-case.ts` (tsx, deterministic): `--src <folder> --id <case-id>` →  `test-fixtures/real-scans/<case-id>/`:
   - copies UpperJaw/LowerJaw/TotalJaw0/TotalJaw1 in **STL and PLY** form, renamed `<case-id>-{upperjaw,lowerjaw,bite0,bite1}.{stl,ply}` (OBJ/MTL/JPG textures NOT copied in Phase 0);
   - **scrubs PHI**: binary STL 80-byte header rewritten to fixed string `DQCAD anonymized fixture`; PLY header `comment` lines containing source filenames replaced with `comment anonymized`; verify (automated assertion in the script) that the output bytes contain no case-insensitive occurrence of the source folder's patient-name tokens;
   - parses `.matrix4` into `alignmentMatrix` (16 numbers, column order documented) and selected non-PHI fields of `.dentalProject` (`AntagonistType`, `ToothColor`) into `manifest.json` alongside sha256, triangle/vertex counts, bbox per mesh; PatientName/PracticeName/DateTime/ProjectGUID must NOT appear;
   - idempotent: re-running produces byte-identical outputs.
2. Import both cases as `arch-case-01` (the older source folder) and `arch-case-02` (the newer source folder).
3. LFS: ensure `.gitattributes` covers `test-fixtures/**/*.ply` too; fixtures committed via LFS.
4. Golden test additions (vitest `golden` project): for each real fixture, sha256 matches manifest; PLY headers contain no `TextureFile` comments and no patient tokens (hard assertion); triangle counts within manifest.
5. `test-fixtures/real-scans/README.md`: provenance (Shining 3D scanner → exocad export, anonymized by script, date removed), what each file role means (upperJaw/lowerJaw/bite), and the note that a crown-prep case is still needed for Phase 3.

**Verify:** import script run twice → `git status` clean; grep for patient tokens over `test-fixtures/` returns nothing; `npm run test:golden` green; `git lfs ls-files` lists the new fixtures. Commit (fixtures via LFS).
