import { expect, test } from '@playwright/test';

// Phase 0 acceptance (docs/plans/phase-0-foundation.md): "npm run dev boots
// UI+server; a worker round-trips a mesh buffer; CI green." This spec
// exercises that acceptance end-to-end in a real browser — deliberately the
// only e2e spec for Phase 0 (YAGNI: broader UI coverage is a later-phase
// concern once there's an actual design workflow to test).

test('app shell renders, both smoke tests pass, and /api/health proxies through', async ({
  page,
}) => {
  await page.goto('/');

  // 1. App shell renders — header title visible.
  await expect(page.getByTestId('app-title')).toHaveText('DQ Dental CAD');

  // 2. Worker smoke test: round-trips a real mesh buffer through a browser
  // Web Worker (apps/client/src/engine/workers.ts -> @dqcad/kernel-workers).
  await page.getByTestId('worker-smoke-test-button').click();
  await expect(page.getByTestId('worker-smoke-test-status')).toHaveText(
    'Worker: ✓ 1000 triangles',
    { timeout: 30_000 },
  );

  // 3. Manifold smoke test: runs manifold-3d WASM inside the same worker.
  await page.getByTestId('manifold-smoke-test-button').click();
  await expect(page.getByTestId('manifold-smoke-test-status')).toHaveText(
    'Manifold: ✓ volume 1.500',
    { timeout: 30_000 },
  );

  // 4. GET /api/health through the Vite dev proxy reaches the Fastify API.
  // Wrapped in `toPass` (bounded polling, no arbitrary sleep) because the
  // client and server halves of `npm run dev` start concurrently and the
  // server side additionally runs a migration before it starts listening.
  await expect(async () => {
    const response = await page.request.get('/api/health');
    expect(response.ok()).toBe(true);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ status: 'ok' });
  }).toPass({ timeout: 30_000 });
});
