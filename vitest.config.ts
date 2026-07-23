import { defineConfig } from 'vitest/config';

function project(name: string, root: string) {
  return {
    test: {
      name,
      root,
      environment: 'node' as const,
      include: ['src/**/*.test.ts'],
      passWithNoTests: true,
      // Phase 2 Task 12 fix (full-suite timing flakiness under CPU
      // contention — see .superpowers/sdd/progress.md's P2 Task 11
      // carry-over note): several kernel/kernel-workers test files (e.g.
      // boolean/manifold.analytic.test.ts, curvature analytic/property
      // tests) have NO custom per-test timeout and no wall-clock budget
      // assertion of their own — they were observed flaking under
      // Vitest's default 5000ms per-test timeout specifically when other
      // heavy suites (now isolated — see offsetMesh.test.ts's
      // RUN_OFFSET_ACCEPTANCE gate) shared CPU in the same `npm test` run.
      // 15s is generous defense-in-depth headroom for any normally-sub-
      // second test to tolerate real noisy-neighbor contention without
      // masking a genuine hang (individual slow tests still set their own
      // larger explicit `{ timeout }`, unaffected by this default).
      testTimeout: 15_000,
    },
  };
}

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      project('shared-types', './packages/shared-types'),
      project('clinical-profiles', './packages/clinical-profiles'),
      project('tooth-library', './packages/tooth-library'),
      project('kernel', './packages/kernel'),
      project('kernel-workers', './packages/kernel-workers'),
      project('io', './packages/io'),
      project('cad-pipeline', './packages/cad-pipeline'),
      {
        test: {
          name: 'server',
          root: './apps/server',
          environment: 'node' as const,
          include: ['src/**/*.test.ts'],
          passWithNoTests: true,
          // Isolated from the dev DB (apps/server/prisma/dev.db); migrated fresh
          // by globalSetup before each run so tests never depend on dev-time state.
          env: { DATABASE_URL: 'file:./test.db' },
          globalSetup: ['./vitest.global-setup.ts'],
          testTimeout: 20_000,
        },
      },
      project('client', './apps/client'),
      // Browser-mode DOM project (Phase 2 Task 12) — a separate CONFIG FILE
      // (not an inline object here) so it can resolve `@vitejs/plugin-react`
      // from apps/client's own node_modules/dependency graph rather than the
      // repo root's (which hoists a different, incompatible vite major via
      // vitest's own transitive dependency) — see apps/client/vitest.config.ts's
      // module doc for the full reasoning, and apps/client/src/ui/README.md
      // for the lane's conventions.
      './apps/client/vitest.config.ts',
      {
        test: {
          name: 'tooling',
          root: '.',
          environment: 'node',
          include: ['eslint.boundaries.test.ts'],
          passWithNoTests: true,
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'golden',
          root: '.',
          environment: 'node',
          // Root-level test dir (not a workspace package) — golden tests
          // regenerate fixtures via scripts/generate-fixtures.ts and check
          // the checked-in test-fixtures/ tree, so they don't belong to any
          // single package.
          include: ['test/golden/**/*.test.ts'],
          passWithNoTests: true,
          // Bumped 30_000 -> 90_000 (Phase 2 Task 12 fix, same full-suite
          // timing-flakiness class as the shared project() helper's
          // testTimeout above): this project's fixtures are REAL
          // clinical-scale scans (e.g. test/golden/curvature.test.ts's
          // ~250k-vertex upperjaw H/K/k1/k2 finite-value assertion iterates
          // every vertex with 2 `expect()` calls each — real, non-trivial
          // per-call overhead at that count) — observed to exceed 30s under
          // `npm test`'s full parallel run even after isolating the
          // dominant CPU hog (offsetMesh.test.ts's RUN_OFFSET_ACCEPTANCE
          // gate) and bumping every OTHER project's default. 90s matches
          // this project's own kernel-ops.test.ts beforeAll hook timeout
          // (also bumped this task, see that file) as the project-wide
          // contention-tolerant baseline.
          testTimeout: 90_000,
        },
      },
    ],
  },
});
