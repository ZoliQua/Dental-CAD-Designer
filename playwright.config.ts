import { defineConfig, devices } from '@playwright/test';

// Phase 0 e2e smoke (docs/plans/phase-0-foundation.md, Task 7). Ports are
// fixed by the Global Constraints (Vite 5173, Fastify 4100) — `webServer`
// boots both via the root `npm run dev` (concurrently), so a single command
// gets the full stack (client + API + workers) up for the smoke spec.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    // Locally, reuse a server the developer already has running (fast
    // iteration loop). In CI there is never a pre-existing server, so
    // always start a fresh one there.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
