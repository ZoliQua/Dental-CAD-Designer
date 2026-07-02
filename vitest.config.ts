import { defineConfig } from 'vitest/config';

function project(name: string, root: string) {
  return {
    test: {
      name,
      root,
      environment: 'node' as const,
      include: ['src/**/*.test.ts'],
      passWithNoTests: true,
    },
  };
}

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      project('shared-types', './packages/shared-types'),
      project('kernel', './packages/kernel'),
      project('kernel-workers', './packages/kernel-workers'),
      project('io', './packages/io'),
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
          testTimeout: 30_000,
        },
      },
    ],
  },
});
