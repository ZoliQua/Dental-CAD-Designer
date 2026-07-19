# Client component ("client-dom") test lane

Phase 2 Task 12. This is the first real-DOM component test lane in the
repo — every prior client test (22 files under `apps/client/src/engine/` and
`apps/client/src/state/`) is node-only, testing pure logic/state, never a
mounted React component (see CLAUDE.md's `ui → engine → kernel-workers →
kernel` layering: UI stays thin on purpose, so most behavior IS already
covered one layer down — but per-task reviews kept flagging genuine gaps at
the component layer itself: conditional render/show-hide logic, inline
error-path handling, and form-input behavior that only exists in the JSX,
not in an extracted helper).

## Decision: Vitest **browser mode** (Playwright provider), not jsdom

The brief asked for an evaluation, browser mode preferred ("real DOM + real
events, matches the repo's no-mock philosophy"). A genuine attempt was made
and it worked cleanly:

- `@vitest/browser@3.2.7` (matching the repo's `vitest@3.2.7`) + the
  built-in Playwright provider. **No new browser-binary install needed** —
  `@vitest/browser`'s `playwright` peer dependency deduped against the
  `playwright@1.61.1` package `@playwright/test` (already a root
  devDependency for `e2e/`) already pulls in, and the same Chromium binary
  `npx playwright install --with-deps chromium` (already a CI step for
  `test:e2e`) installs is reused — confirmed via `npm ls playwright`.
- Real components render in a real Chromium page, with real user events
  (`@testing-library/user-event`) and — the actual point of choosing
  browser mode over jsdom for THIS repo — **real Web Workers**. Several
  tests here drive the exact browser Worker path
  (`packages/kernel-workers/src/pool.ts`'s `spawnBrowserWorker`, real
  Comlink round trips, real `@dqcad/kernel` algorithms running inside the
  worker) that jsdom cannot execute at all (jsdom has no `Worker`
  implementation). A RepairPanel test asserts on the result of a REAL
  `previewFillSmallHoles` worker job; a SurfaceDistancePanel test asserts on
  a REAL `buildBvh` + `distanceHeatmap` worker job pair (affinity-routed —
  see `packages/kernel-workers/src/pool.ts`'s `RunJobOptions.affinityKey`).
  This is strictly more real than jsdom + a worker mock/stub would ever be.
- The one real friction hit, and how it was resolved (see
  `apps/client/vitest.config.ts`'s module doc for the full explanation): the
  repo root hoists a DIFFERENT `vite` major (7.x, transitively via
  `vitest`'s own dependency) than `apps/client`'s own `vite@^8` — so
  `@vitejs/plugin-react` (needed for JSX transform) cannot be added as a
  ROOT devDependency without an npm peer-dependency conflict. Fix: the
  `client-dom` project is defined in its own config file,
  `apps/client/vitest.config.ts` (referenced from the root
  `vitest.config.ts`'s `projects` array by **path string**, not an inline
  object — see that array's comment), so `@vitejs/plugin-react` resolves
  from `apps/client`'s own `node_modules` (its own `vite@^8` peer
  satisfied there), exactly like `apps/client/vite.config.ts` (the real dev
  server config) already does. No root dependency changes were needed.

**jsdom was not needed as a fallback** — this counts as "genuine attempt
succeeded", not "fell back" per the task brief's guardrail.

## Conventions (for Phase 3 and beyond)

- **File naming**: `*.dom.test.tsx` (matches the `client-dom` project's
  `include: ['src/**/*.dom.test.tsx']` in `apps/client/vitest.config.ts`) —
  deliberately a DIFFERENT suffix than the existing node-only `client`
  project's `src/**/*.test.ts` (that project's `include` glob only ever
  matched `.ts`, not `.tsx`, so there is zero collision risk between the two
  lanes even for a file that happened to share a base name).
- **No mocking** (repo-wide convention, extended here): render the REAL
  component against REAL `engine`/`state` modules with fabricated-but-real
  fixtures (same pattern `engine/repair.test.ts` already uses —
  `caseStore.registerImportedMesh(...)` + `caseStore.addSceneNode(...)` with
  small hand-built meshes), not `vi.mock()`. Two consequences worth knowing
  going in:
  - A component whose async data comes from a REAL kernel-workers job (BVH,
    repair previews, heatmaps, ...) needs a real geometry fixture that
    actually exercises the code path you want (see
    `RepairPanel.dom.test.tsx`'s `oversizedHoleGridMesh()` — a small
    hand-built flat grid sized specifically to exceed
    `fillSmallHoles`'s default `maxBoundaryEdges`, to reach the
    skip-reason UI branch on purpose).
  - A component whose data comes from the SERVER (`engine/persistence.ts`'s
    `fetch('/api/...')`) gets a REAL fetch failure for free in this lane:
    the `client-dom` project's page is served by Vitest's own dev server,
    which has no `/api/*` routes — no need to stub `fetch` at all to test
    an error path (see `CasePicker.dom.test.tsx`). This only works for
    ERROR paths, obviously; there's no real backend here to test a
    success path against (that's what `e2e/` + a real `npm run dev` stack
    is for).
- **Explicit `cleanup()` in `afterEach`** — unlike a jsdom project, this
  lane does NOT get `@testing-library/react`'s implicit auto-cleanup
  wiring (that auto-detection is keyed off finding a jsdom-like global at
  import time, which a real browser page's `document` doesn't trigger the
  same way). Import `cleanup` from `@testing-library/react` and call it in
  every file's own `afterEach` — omitting it leaks one test's rendered DOM
  into the next test in the SAME file, causing spurious
  `getByTestId`/`getByRole` "found multiple elements" failures (this was
  hit and fixed once already, in `CasePicker.dom.test.tsx` — see its
  `afterEach` comment).
- **`apps/client/vitest.setup.dom.ts`** sets
  `globalThis.IS_REACT_ACT_ENVIRONMENT = true` (wired via this project's
  `setupFiles`) — React 18's `act()` auto-detection doesn't recognize a
  real browser `document` the way it recognizes jsdom's; without this every
  `user-event` interaction logs a harmless-but-noisy
  `"not configured to support act(...)"` console warning.
- **i18n**: `import '../i18n'` (side-effect) once per test file before
  rendering anything that calls `useTranslation()` — it synchronizes
  synchronously (bundled JSON resources, no network fetch — see
  `apps/client/src/i18n/index.ts`), so no `waitFor` is needed just for
  translations to be ready. Assertions on translated text should prefer a
  stable `data-testid`/`role`/label over a hardcoded English string where
  the component provides one; where it doesn't (e.g. a summary paragraph
  with no testid), match a stable ENGLISH substring and say so in a comment
  (EN is `DEFAULT_LANGUAGE` — see that same file) rather than silently
  assuming it'll always be English.
- **Real async work needs a real wait**: `screen.findByTestId(...)` /
  `waitFor(...)` with a generous timeout (10s is used throughout this
  lane's existing tests) for anything that goes through a real worker job —
  these are genuinely async (a real Comlink round trip through a real
  browser Worker), not a microtask-flush-away.

## Running this lane

- `npm test` (root) runs it automatically — it's one more entry in the root
  `vitest.config.ts`'s `projects` array, exactly like every other project.
- `npx vitest run --project client-dom` runs ONLY this lane.
- CI: no extra step needed beyond what `test:e2e` already requires
  (`npx playwright install --with-deps chromium`, already a step in
  `.github/workflows/ci.yml` before the e2e step) — but note that step
  currently runs AFTER "Unit tests" (`npm test`) in the `ci` job's step
  order, so if this project's Chromium instance isn't already cached
  locally/in the runner image the FIRST `npm test` run in a fresh
  environment needs Playwright's browsers available before it gets there;
  `npx playwright install --with-deps chromium` before `npm test` (or
  relying on `@playwright/test`'s own postinstall / a warm CI cache) covers
  this. Locally, if you've ever run `npm run test:e2e` on this machine
  before, the browser is already cached and this lane just works.

## Scope (what this lane deliberately does NOT try to do)

Per the brief's guardrail ("browser lane proves 3 tests, not a full
migration"): this task ported/added 3 representative components
(`RepairPanel`, `CasePicker`, `SurfaceDistancePanel` — the exact gaps prior
per-task reviews flagged), not a wholesale migration of every `ui/*.tsx`
file. Phase 3's margin-line/insertion-axis tooling is interaction-dense
(per PLAN.md) and should lean on this same lane going forward — the
conventions above are written for that, not just to explain what's already
here.
