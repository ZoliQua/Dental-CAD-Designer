import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStl } from '@dqcad/io';
import { buildBvh, closestPoint, intake, type Vec3 } from '@dqcad/kernel';
import { skipOnboardingTour } from './support';

// Phase 9 Task 7 — the crown phase-gate walkthrough on the REAL arch-case-01
// upper jaw (tooth 11), through the real UI: its proximal neighbours 12 / 21
// are CAPTURED from the same scan (Task 3 — one canvas pick per side, the
// real `raycastMesh` + `extractNeighbourRegion` jobs), so the anatomy and the
// contact gate are measured on the case's geometry, not on stand-in boxes.
//
// ## Seeded inputs
//
// - The margin: arch-case-01's committed hand-traced tooth-11 reference
//   (anchors + dense points), via the DEV-only `seedConfirmedMargin` hook —
//   tooth 11's curvature ridge does not close under auto-propose
//   (docs/demos/phase-3-task-8-evidence.md); the editor is e2e/phase3's.
// - The pick points: the centroid of each neighbour's reference trace,
//   lifted 3 mm along the confirmed insertion axis and snapped onto the scan
//   (test/golden/neighbour-capture-acceptance.test.ts's construction),
//   projected to the canvas and CLICKED — the real pick path underneath.
//
// ## What this walkthrough proves — and the honest stop
//
// The capture runs on the real scan through the real UI, and each capture is
// journaled against the scan's mesh. A full-arch intraoral scan is an OPEN
// surface (2624 boundary edges on this one), and the intaglio's signed-distance
// offset needs a closed die. Phase 10 (ADR-023) closes that gap: the
// "Prepare die" step cuts the closed prep from the scan, with a clearance
// certificate, and the intaglio is built on it. The later stages on this
// UNPREPARED tooth are Phase 10 Task 6's (their thickness and seating verdicts
// honestly fail). The contact gate measured on these captured neighbours is
// proven at the pipeline level by test/golden/neighbour-capture-acceptance.
// test.ts (RUN_NEIGHBOUR_CAPTURE_REAL=1).

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const UPPER_PATH = join(repoRoot, 'test-fixtures', 'real-scans', 'arch-case-01', 'arch-case-01-upperjaw.stl');

interface Reference {
  anchors: { position: Vec3; triangleIndex: number; barycentric: Vec3 }[];
  closed: boolean;
  resampledPoints: Vec3[];
}
function reference(tooth: number): Reference {
  return JSON.parse(
    readFileSync(join(repoRoot, 'test-fixtures', 'margins', 'arch-case-01', `${tooth}.reference.json`), 'utf8'),
  ) as Reference;
}

function centroid(points: readonly Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  return [x / points.length, y / points.length, z / points.length];
}

async function hook<T>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ({ name, args }) => {
      const hooks = (window as unknown as { __dqcadTestHooks__?: Record<string, (...a: unknown[]) => unknown> }).__dqcadTestHooks__;
      if (!hooks) throw new Error('__dqcadTestHooks__ missing');
      return hooks[name]!(...args) as T;
    },
    { name, args },
  );
}

test.describe.serial('Phase 9 — a crown on the real arch-case-01 with captured neighbours', () => {
  test.setTimeout(900_000);

  let page: Page;
  let restorationId: string;
  const caseName = `Phase9 Crown E2E ${Date.now()}`;
  // The browser's own intake of the same bytes is byte-identical (CLAUDE.md
  // invariant 2), so picks computed here land on the app's mesh.
  const upper = (() => {
    const bytes = readFileSync(UPPER_PATH);
    const { soup } = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return intake({ kind: 'soup', soup }).mesh;
  })();
  const upperBvh = buildBvh(upper);

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await skipOnboardingTour(page);
  });
  test.afterAll(async () => {
    await page.close();
  });

  test('imports the real upper jaw, a crown on 11 with its confirmed margin and insertion axis', async () => {
    await page.goto('/');
    await page.getByTestId('open-case-picker-button').click();
    await page.getByTestId('case-picker-new-case-name').fill(caseName);
    await page.getByTestId('case-picker-new-case-name').press('Enter');
    await expect(page.getByTestId('active-case-name')).toHaveText(caseName);

    await page.getByTestId('import-file-input').setInputFiles(UPPER_PATH);
    const row = page.getByTestId('import-file-row').filter({ hasText: 'arch-case-01-upperjaw.stl' });
    await expect(row.getByTestId('import-role-select')).toBeVisible({ timeout: 120_000 });
    await row.getByTestId('import-role-select').selectOption('upperJaw');
    await expect(page.getByTestId('scene-tree-row')).toHaveCount(1);

    await page.getByTestId('restoration-type-crown').click();
    await page.getByTestId('fdi-tooth-11').click();
    await page.getByTestId('restoration-target-select').selectOption({ index: 1 });
    await page.getByTestId('restoration-submit-button').click();
    await expect(page.getByTestId('restoration-chip-11')).toBeVisible();
    restorationId = (await page.locator('[data-testid="crown-restoration-select"] option').nth(1).getAttribute('value'))!;

    const ref11 = reference(11);
    await hook(page, 'seedConfirmedMargin', restorationId, 11, {
      anchors: ref11.anchors,
      closed: ref11.closed,
      resampledPoints: ref11.resampledPoints,
    });

    // The real axis tool: auto-suggest on the margin's region, confirm.
    await page.getByTestId('axis-restoration-select').selectOption({ index: 1 });
    await page.getByTestId('axis-start-button').click();
    await page.getByTestId('axis-suggest-button').click();
    await expect(page.getByTestId('axis-abutment-table')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('axis-error')).toHaveCount(0);
    await page.getByTestId('axis-confirm-button').click();
    await expect(page.getByTestId('axis-confirmed-indicator')).toBeVisible({ timeout: 10_000 });
  });

  test('captures 21 (mesial) and 12 (distal) from the scan with one canvas pick each; each capture is journaled against the scan', async () => {
    await page.getByTestId('crown-restoration-select').selectOption(restorationId);
    await page.getByTestId('crown-start-button').click();
    await expect(page.getByTestId('crown-panel')).toBeVisible();

    const axis = (await hook<Vec3 | null>(page, 'getRestorationAxis', restorationId))!;
    const canvas = page.locator('canvas');
    const box = (await canvas.boundingBox())!;
    for (const [side, tooth] of [
      ['mesial', 21],
      ['distal', 12],
    ] as const) {
      const c = centroid(reference(tooth).resampledPoints);
      const lifted: Vec3 = [c[0] + axis[0] * 3, c[1] + axis[1] * 3, c[2] + axis[2] * 3];
      const point = closestPoint(upper, upperBvh, lifted).point;
      await page.getByTestId(`crown-capture-${side}-pick`).click();
      await expect(page.getByTestId(`crown-capture-${side}-hint`)).toBeVisible();
      const px = await hook<{ x: number; y: number } | null>(page, 'worldToCanvasPoint', [point[0], point[1], point[2]]);
      expect(px, `${side} pick projects onto the canvas`).not.toBeNull();
      expect(px!.x).toBeGreaterThan(0);
      expect(px!.x).toBeLessThan(box.width);
      expect(px!.y).toBeGreaterThan(0);
      expect(px!.y).toBeLessThan(box.height);
      await page.mouse.click(box.x + px!.x, box.y + px!.y);
      await expect(page.getByTestId(`crown-capture-${side}-captured`)).toBeVisible({ timeout: 300_000 });
      await expect(page.getByTestId(`crown-capture-${side}-captured`)).toContainText('µm');
      await expect(page.getByTestId('crown-error')).toHaveCount(0);
      const op = await hook<{ params: Record<string, unknown>; inputHashes: string[] }>(page, 'getLatestOperation', 'neighbour-capture');
      expect(op.params['side']).toBe(side);
      expect(op.params['restorationId']).toBe(restorationId);
      expect(op.inputHashes[0]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('the die is cut from the open arch scan, certified, and the intaglio is built on it (Phase 10)', async () => {
    // Before Phase 10 the intaglio refused this open scan ("not watertight").
    // Now the prepared die closes the prep alone, with its certificate shown.
    await expect(page.getByTestId('crown-innerSurface-blocked')).toBeVisible();
    await page.getByTestId('crown-prepdie-run').click();
    await expect(page.getByTestId('crown-prepdie-readout')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('crown-error')).toHaveCount(0);
    await expect(page.getByTestId('crown-prepdie-certificate')).toContainText('µm');
    const dieOp = await hook<{ params: Record<string, unknown>; inputHashes: string[]; outputHashes: string[] }>(
      page,
      'getLatestOperation',
      'crown-die-extract',
    );
    expect(dieOp.params['restorationId']).toBe(restorationId);
    expect(dieOp.params['syntheticTriangleCount']).toBeGreaterThan(0);
    expect(dieOp.params['clearanceMm']).toBeGreaterThanOrEqual(dieOp.params['requiredClearanceMm'] as number);
    expect(dieOp.inputHashes[0]).toMatch(/^[0-9a-f]{64}$/);

    await page.getByTestId('crown-inner-pitch').fill('150');
    await page.getByTestId('crown-inner-run').click();
    await expect(page.getByTestId('crown-inner-readout')).toBeVisible({ timeout: 300_000 });
    await expect(page.getByTestId('crown-error')).toHaveCount(0);
    const innerOp = await hook<{ inputHashes: string[] }>(page, 'getLatestOperation', 'crown-inner-surface');
    expect(innerOp.inputHashes[0]).toBe(dieOp.outputHashes[0]);
  });
});
