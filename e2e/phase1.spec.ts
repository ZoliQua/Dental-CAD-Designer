import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Phase 1 acceptance walkthrough (docs/plans/phase-1-import-viewer.md's
// Task 12 brief): import -> intake -> role assign -> standard views ->
// point-to-point measurement -> cross-section -> save -> reload -> restore,
// driven through the REAL app (real file input, real WebGL canvas clicks,
// real worker jobs, real server routes) — not mocked at any layer.
//
// ## Why camera assertions use `window.__dqcadTestHooks__`, not screenshots
//
// A canvas pixel/screenshot assertion for "did the camera move to the
// buccal view" is exactly the kind of flaky, environment-dependent check
// this task's brief explicitly steers away from (font/GPU/anti-aliasing
// differences between CI and a local machine change individual pixels even
// when the camera is in the mathematically correct place). Instead,
// apps/client/src/engine/testHooks.ts exposes a small, DEV-only
// `window.__dqcadTestHooks__` object (installed by src/main.tsx only when
// `import.meta.env.DEV` is true — never present in a production build) with
// two READ-ONLY queries against the real, live `SceneManager`:
//   - `getCameraState()` — the active camera's position + OrbitControls
//     target (render frame), used below to assert a standard-view button
//     click actually re-pointed the camera along the documented axis
//     (engine/standardViews.ts's `FIXED_VIEW_OFFSETS`), not just "some
//     screenshot looks plausible".
//   - `worldToCanvasPoint(point)` — projects a WORLD-frame (Float64 mm)
//     point to the exact CSS-pixel coordinate `SceneManager`'s own real
//     pick handler (`pickAtClientPosition`) would need to hit it, using the
//     SAME camera/canvas-rect math `SceneManager.projectToScreen` already
//     uses for its measurement-label overlay. This lets the point-to-point
//     measurement test below click on an analytically-known point on the
//     synthetic sphere fixture WITHOUT bypassing the real click pipeline —
//     the click below is a genuine `page.mouse` event, dispatched through
//     Chromium's real input stack, landing on a real `pointerdown`/`pointerup`
//     listener, driving a real `Raycaster.setFromCamera` and a real
//     `ToolManager.handlePick` -> `raycastMesh` worker round trip. Only the
//     "which pixel do I click to hit a known 3D point" arithmetic is
//     test-assisted; nothing about the measurement pipeline itself is
//     shortcut.
//
// ## Fixture choice
//
// One REAL clinical-scale scan (`test-fixtures/real-scans/arch-case-01/
// arch-case-01-bite0.stl`, ~5.4 MB / 108,665 triangles) proves the import ->
// intake pipeline against real data, per the brief ("one real-scan import to
// prove the pipeline"). Every other step (camera, measurement, section) uses
// the small synthetic `sphere-r5.stl` fixture (radius 5 mm, centered
// EXACTLY at the origin — see test-fixtures/synthetic/sphere-r5.expected.json
// — subdivision-4 icosphere, same tessellation-error budget Task 9's
// heatmap acceptance fixtures used: ~0.057 µm max chord deviation, see
// scripts/generate-fixtures.ts's derivation) both for speed and because its
// exact analytic geometry is what makes the point-to-point tolerance below
// a meaningful, non-arbitrary number.
const REAL_SCAN_PATH = fileURLToPath(
  new URL('../test-fixtures/real-scans/arch-case-01/arch-case-01-bite0.stl', import.meta.url),
);
const SPHERE_PATH = fileURLToPath(
  new URL('../test-fixtures/synthetic/sphere-r5.stl', import.meta.url),
);

const SPHERE_RADIUS_MM = 5;

interface CanvasPoint {
  x: number;
  y: number;
}

/** Thin wrapper around `window.__dqcadTestHooks__` — see this file's
 * top-of-file doc. Typed loosely (not imported from apps/client/src/engine/
 * testHooks.ts, a DOM-lib/Vite-typed program e2e/'s own root tsconfig
 * doesn't share) since the shape is tiny and stable. */
async function getCameraState(
  page: Page,
): Promise<{ position: [number, number, number]; target: [number, number, number] }> {
  const state = await page.evaluate(() => {
    const hooks = (
      window as unknown as {
        __dqcadTestHooks__?: {
          getCameraState: () => {
            position: [number, number, number];
            target: [number, number, number];
          } | null;
        };
      }
    ).__dqcadTestHooks__;
    return hooks?.getCameraState() ?? null;
  });
  if (!state) {
    throw new Error(
      'window.__dqcadTestHooks__.getCameraState() returned null — viewport not mounted?',
    );
  }
  return state;
}

async function worldToCanvasPoint(
  page: Page,
  point: readonly [number, number, number],
): Promise<CanvasPoint> {
  const projected = await page.evaluate((p) => {
    const hooks = (
      window as unknown as {
        __dqcadTestHooks__?: {
          worldToCanvasPoint: (pt: readonly [number, number, number]) => CanvasPoint | null;
        };
      }
    ).__dqcadTestHooks__;
    return hooks?.worldToCanvasPoint(p) ?? null;
  }, point);
  if (!projected) {
    throw new Error(
      `worldToCanvasPoint(${JSON.stringify(point)}) returned null — camera/viewport not ready?`,
    );
  }
  return projected;
}

function normalize(v: readonly [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function distance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Parses a MeasurementPanel row's displayed value text ("2.588 mm", or
 * "0.500 mm (500 µm)" for sub-mm values — see engine/formatMm.ts) back to a
 * number, for asserting against the analytic expected distance. */
function parseMmValue(text: string): number {
  const match = /^(-?\d+\.\d{3}) mm/.exec(text.trim());
  if (!match) {
    throw new Error(
      `could not parse a "X.XXX mm" value out of measurement text: ${JSON.stringify(text)}`,
    );
  }
  return Number(match[1]);
}

test.describe.serial('Phase 1 acceptance flow', () => {
  let page: Page;
  const caseName = `Phase1 E2E ${Date.now()}`;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('creates a case', async () => {
    await page.goto('/');
    await expect(page.getByTestId('app-title')).toHaveText('DQ Dental CAD');

    await page.getByTestId('open-case-picker-button').click();
    await expect(page.getByTestId('case-picker')).toBeVisible();
    await page.getByTestId('case-picker-new-case-name').fill(caseName);
    await page.getByTestId('case-picker-new-case-name').press('Enter');

    await expect(page.getByTestId('case-picker')).toBeHidden();
    await expect(page.getByTestId('active-case-name')).toHaveText(caseName);
  });

  test('imports the synthetic sphere fixture and assigns a role', async () => {
    await page.getByTestId('import-file-input').setInputFiles(SPHERE_PATH);

    const row = page.getByTestId('import-file-row').filter({ hasText: 'sphere-r5.stl' });
    await expect(row.getByTestId('import-role-select')).toBeVisible({ timeout: 15_000 });
    // Intake stats are rendered right alongside the role selector (see
    // ImportPanel.tsx's MeshSummary) — its presence IS "intake stats
    // visible" for this small, fast, watertight synthetic fixture.
    await expect(row.locator('.import-summary__stats')).toBeVisible();

    await row.getByTestId('import-role-select').selectOption('upperJaw');
    await expect(page.getByTestId('scene-tree-row')).toHaveCount(1);
    await expect(page.getByTestId('scene-tree-row').first()).toContainText('sphere-r5.stl');
  });

  test('standard-view buttons move the camera along the documented axis', async () => {
    // engine/standardViews.ts's FIXED_VIEW_OFFSETS: front = [0,0,1] (camera
    // in front of the target, looking toward -Z), buccal = [1,0,0].
    await page.getByTestId('view-button-front').click();
    const front = await getCameraState(page);
    const frontDirection = normalize([
      front.position[0] - front.target[0],
      front.position[1] - front.target[1],
      front.position[2] - front.target[2],
    ]);
    // Camera is framed on the sphere alone (only scene node) — target
    // should sit at the sphere's own center, the world/render origin (see
    // sphere-r5.expected.json's bbox: [-5,-5,-5]..[5,5,5]).
    expect(distance(front.target, [0, 0, 0])).toBeLessThan(0.5);
    expect(dot(frontDirection, [0, 0, 1])).toBeGreaterThan(0.999);

    await page.getByTestId('view-button-buccal').click();
    const buccal = await getCameraState(page);
    const buccalDirection = normalize([
      buccal.position[0] - buccal.target[0],
      buccal.position[1] - buccal.target[1],
      buccal.position[2] - buccal.target[2],
    ]);
    expect(dot(buccalDirection, [1, 0, 0])).toBeGreaterThan(0.999);
    // And the camera actually MOVED (not a no-op) — front and buccal are
    // 90 degrees apart, so at the framed distance the position shift is on
    // the order of several mm, comfortably above any float-precision noise.
    expect(distance(front.position, buccal.position)).toBeGreaterThan(1);

    // Return to front for the next step's known, analytically-derived
    // click geometry.
    await page.getByTestId('view-button-front').click();
  });

  test('point-to-point measurement on the sphere matches the analytic chord distance', async () => {
    // Two points on the sphere's camera-facing (front, +Z) hemisphere:
    //   A = the pole facing the camera exactly, (0, 0, 5) — dead center of
    //       the framed front view, so the click ray is normal-incident
    //       (zero grazing angle: no pixel-to-surface amplification).
    //   B = 30 degrees away from A along the sphere's surface, in the XZ
    //       plane: (r*sin(30deg), 0, r*cos(30deg)).
    // Analytic chord distance: 2 * r * sin(angle / 2) = 2*5*sin(15deg).
    const pointA: [number, number, number] = [0, 0, SPHERE_RADIUS_MM];
    const angleRad = (30 * Math.PI) / 180;
    const pointB: [number, number, number] = [
      SPHERE_RADIUS_MM * Math.sin(angleRad),
      0,
      SPHERE_RADIUS_MM * Math.cos(angleRad),
    ];
    const expectedDistanceMm = 2 * SPHERE_RADIUS_MM * Math.sin(angleRad / 2);

    await page.getByTestId('measure-tool-pointToPoint').click();
    await expect(page.getByTestId('measure-hint')).toContainText('0 of 2');

    const canvas = page.locator('canvas');
    const canvasA = await worldToCanvasPoint(page, pointA);
    await canvas.click({ position: { x: canvasA.x, y: canvasA.y } });
    await expect(page.getByTestId('measure-hint')).toContainText('1 of 2', { timeout: 10_000 });

    const canvasB = await worldToCanvasPoint(page, pointB);
    await canvas.click({ position: { x: canvasB.x, y: canvasB.y } });

    const row = page.getByTestId('measurement-row').first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    const valueText = await row.locator('.measurement-list__value').innerText();
    const measuredMm = parseMmValue(valueText);

    // Tolerance: NOT the kernel-level ±1 µm acceptance budget (that's
    // proven directly against Float64 buffers by
    // packages/kernel/src/section/polyline.test.ts /
    // packages/kernel-workers/src/distanceHeatmap.test.ts — see
    // docs/demos/phase-1.md's acceptance table). This click travels through
    // a real WebGL canvas: CSS-pixel rounding on the click position shifts
    // where the ray actually lands on the mesh surface by a fraction of a
    // pixel's worth of world-space mm (the framed sphere spans roughly
    // 13.5 mm across a several-hundred-px canvas here, i.e. well under
    // 0.05 mm per pixel) — 0.1 mm (100 um) is a generous, honestly-reasoned
    // bound on THAT source of error, an order of magnitude above the
    // fixture's own ~0.057 um tessellation error (see this file's
    // top-of-file doc).
    expect(Math.abs(measuredMm - expectedDistanceMm)).toBeLessThan(0.1);
  });

  test('cross-section tool opens and computes a real section through the sphere', async () => {
    await expect(page.getByTestId('section-panel')).toBeVisible();
    await page.getByTestId('section-enabled-toggle').check();
    await page.getByTestId('section-axis-z').click();

    const status = page.getByTestId('section-point-count');
    await expect(status).toBeVisible({ timeout: 10_000 });
    const text = await status.innerText();
    const match = /^(\d+) outline point/.exec(text.trim());
    expect(match, `unexpected section-point-count text: ${JSON.stringify(text)}`).not.toBeNull();
    // A Z-through-center plane cuts the sphere in a single closed circle —
    // any positive point count proves the real sectionMesh worker job ran
    // end to end (not just that the panel opened).
    expect(Number(match![1])).toBeGreaterThan(0);
  });

  test('imports a real clinical-scale scan and shows intake stats', async () => {
    await page.getByTestId('import-file-input').setInputFiles(REAL_SCAN_PATH);

    const row = page.getByTestId('import-file-row').filter({ hasText: 'arch-case-01-bite0.stl' });
    // 108,665 triangles through the real worker pipeline (read -> parse ->
    // intake) — generous timeout for a slower CI runner.
    await expect(row.getByTestId('import-role-select')).toBeVisible({ timeout: 30_000 });
    await expect(row.locator('.import-summary__stats')).toBeVisible();
    // Spot-check one real stat rather than the whole table: watertight
    // "No" is the correct, expected reading for a bite-registration scan
    // (see .superpowers/sdd/p1-task-9-report.md's manual verification —
    // same file, same real, non-watertight characteristic).
    await expect(row.locator('.import-summary__stats')).toContainText('No');

    // No literal "bite scan" role exists in Phase 1's MeshRole enum
    // (upperJaw/lowerJaw/prepDie/antagonist/situ/gingiva) — 'situ' is used
    // here purely to exercise the role-assignment UI mechanism itself
    // (this step's point is proving import->intake against real data, not
    // asserting a clinically-correct role).
    await row.getByTestId('import-role-select').selectOption('situ');
    await expect(page.getByTestId('scene-tree-row')).toHaveCount(2);
  });

  test('saves the case', async () => {
    await expect(page.getByTestId('save-button')).toBeEnabled();
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15_000 });
  });

  test('reloads the page and restores the case (scene tree count + names)', async () => {
    await page.reload();
    await expect(page.getByTestId('app-title')).toHaveText('DQ Dental CAD');
    await expect(page.getByTestId('active-case-name')).toHaveText('No case open');
    await expect(page.getByTestId('scene-tree-row')).toHaveCount(0);

    await page.getByTestId('open-case-picker-button').click();
    await expect(page.getByTestId('case-picker')).toBeVisible();
    const caseRow = page.getByTestId('case-picker-row').filter({ hasText: caseName });
    await expect(caseRow).toBeVisible({ timeout: 10_000 });
    await caseRow.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByTestId('case-picker')).toBeHidden({ timeout: 15_000 });

    await expect(page.getByTestId('active-case-name')).toHaveText(caseName);
    const rows = page.getByTestId('scene-tree-row');
    await expect(rows).toHaveCount(2);
    const names = await rows.locator('.scene-tree__name').allInnerTexts();
    expect(names.sort()).toEqual(['arch-case-01-bite0.stl', 'sphere-r5.stl']);

    // Bonus restore-fidelity check (not strictly required by this task's
    // brief's "tree node count + names", but cheap and directly relevant):
    // the point-to-point measurement recorded before the reload survived
    // the save/reload/open round trip too.
    await expect(page.getByTestId('measurement-row')).toHaveCount(1);
  });
});
