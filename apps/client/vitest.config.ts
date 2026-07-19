// apps/client/vitest.config.ts
//
// The `client-dom` Vitest project (Phase 2 Task 12 — see apps/client/src/ui/
// README.md for the full lane writeup). Deliberately a SEPARATE config file
// living IN apps/client, rather than another inline object in the root
// vitest.config.ts's `projects` array (referenced from there by path — see
// that file) — this is what lets it `import react from '@vitejs/plugin-react'`
// and resolve it from apps/client's OWN node_modules/@vitejs/plugin-react,
// which peer-depends on apps/client's OWN vite@^8. The repo root hoists a
// DIFFERENT vite major (vitest's own transitive vite@^7 dependency) to
// node_modules/vite, so adding @vitejs/plugin-react as a ROOT devDependency
// (importable from a root-level config) fails npm's peer-dependency
// resolution outright (`vite@8.1.4` required by the plugin vs. `vite@7.3.6`
// hoisted at root) — this file sidesteps that conflict entirely by staying
// inside apps/client's own dependency graph, exactly like apps/client's own
// `vite.config.ts` (the dev-server config) already does.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'client-dom',
    include: ['src/**/*.dom.test.tsx'],
    passWithNoTests: true,
    testTimeout: 15_000,
    setupFiles: ['./vitest.setup.dom.ts'],
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
