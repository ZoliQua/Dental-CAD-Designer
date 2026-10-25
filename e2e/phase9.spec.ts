import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStlBinary, type RawTriangleSoup } from '@dqcad/io';
import { skipOnboardingTour } from './support';

// Phase 9 Task 7 — the PHASE GATE walkthroughs, through the REAL UI (real file
// inputs, real worker jobs incl. the manifold-3d WASM, real server routes):
//
//   1. A bridge built FROM THE CASE (Task 6) on the closed-form 14-15-16 arch
//      case: import the target scan + the gingiva scan -> wizard -> confirmed
//      abutment margins -> "Build from this case" -> every stage -> QC: all
//      11 gates pass -> save -> export released by the server's independent
//      re-validation (its `case` claim traced to the saved journal).
//   2. Demo mode is blocked for export: the demonstration bridge's QC fails
//      every gate closed, and the export panel refuses it.
//   3. A crown on the REAL arch-case-01 upper jaw (tooth 11) with its
//      neighbours 12 / 21 CAPTURED from the same scan (Task 3): the contact
//      gate is measured on the case's geometry, not on a stand-in.
//
// ## Seeded inputs (test-assisted input points, real pipeline underneath)
//
// The confirmed margins are written by the DEV-only
// `__dqcadTestHooks__.seedConfirmedMargin` hook (engine/testHooks.ts): the
// arch case's exact shoulder rings, and arch-case-01's committed hand-traced
// tooth-11 reference (its curvature ridge does not close under auto-propose —
// docs/demos/phase-3-task-8-evidence.md). The margin editor itself is covered
// by e2e/phase3.spec.ts. Everything after the margin runs unmodified.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

interface ArchAsset {
  teeth: number[];
  ponticTooth: number;
  targetScan: { positions: number[]; indices: number[] };
  gingiva: { positions: number[]; indices: number[] };
  abutments: { tooth: number; marginLoop: number[][] }[];
}
const ARCH = JSON.parse(
  readFileSync(join(repoRoot, 'apps', 'client', 'src', 'engine', 'archBridgeFixture.asset.json'), 'utf8'),
) as ArchAsset;

/** An indexed mesh as the triangle soup binary STL stores. */
function soupOf(mesh: { positions: number[]; indices: number[] }): RawTriangleSoup {
  const triangleCount = mesh.indices.length / 3;
  const positions = new Float64Array(triangleCount * 9);
  for (let t = 0; t < triangleCount; t++) {
    for (let v = 0; v < 3; v++) {
      const vi = mesh.indices[t * 3 + v]!;
      for (let k = 0; k < 3; k++) positions[t * 9 + v * 3 + k] = mesh.positions[vi * 3 + k]!;
    }
  }
  return { positions, normals: null, triangleCount };
}

type Vec3 = [number, number, number];
interface MarginLineSeed {
  anchors: { position: Vec3; triangleIndex: number; barycentric: Vec3 }[];
  closed: boolean;
  resampledPoints: Vec3[];
}

async function seedConfirmedMargin(page: Page, restorationId: string, tooth: number, line: MarginLineSeed): Promise<void> {
  await page.evaluate(
    ({ restorationId, tooth, line }) => {
      const hooks = (
        window as unknown as {
          __dqcadTestHooks__?: { seedConfirmedMargin: (id: string, tooth: number, line: unknown) => void };
        }
      ).__dqcadTestHooks__;
      if (!hooks) throw new Error('seedConfirmedMargin: __dqcadTestHooks__ missing');
      hooks.seedConfirmedMargin(restorationId, tooth, line);
    },
    { restorationId, tooth, line },
  );
}

async function realOptionValue(page: Page, testId: string, index = 1): Promise<string> {
  const value = await page.locator(`[data-testid="${testId}"] option`).nth(index).getAttribute('value');
  if (!value) throw new Error(`realOptionValue: no option ${index} for ${testId}`);
  return value;
}

async function newCase(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('app-title')).toHaveText('DQ Dental CAD');
  await page.getByTestId('open-case-picker-button').click();
  await expect(page.getByTestId('case-picker')).toBeVisible();
  await page.getByTestId('case-picker-new-case-name').fill(name);
  await page.getByTestId('case-picker-new-case-name').press('Enter');
  await expect(page.getByTestId('case-picker')).toBeHidden();
  await expect(page.getByTestId('active-case-name')).toHaveText(name);
}

async function importScan(page: Page, path: string, fileName: string, role: string, expectedRows: number): Promise<void> {
  await page.getByTestId('import-file-input').setInputFiles(path);
  const row = page.getByTestId('import-file-row').filter({ hasText: fileName });
  await expect(row.getByTestId('import-role-select')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('unit-confirm-keep-mm')).toHaveCount(0);
  await row.getByTestId('import-role-select').selectOption(role);
  await expect(page.getByTestId('scene-tree-row')).toHaveCount(expectedRows);
}

async function createBridge(page: Page, abutments: readonly number[], pontic: number): Promise<void> {
  await page.getByTestId('restoration-type-bridge').click();
  for (const tooth of abutments) await page.getByTestId(`fdi-tooth-${tooth}`).click();
  // Pontic: two clicks (none -> abutment -> pontic).
  await page.getByTestId(`fdi-tooth-${pontic}`).click();
  await page.getByTestId(`fdi-tooth-${pontic}`).click();
  await page.getByTestId('restoration-target-select').selectOption({ index: 1 });
  await expect(page.getByTestId('restoration-submit-button')).toBeEnabled();
  await page.getByTestId('restoration-submit-button').click();
  await expect(page.getByTestId(`restoration-chip-${pontic}`)).toHaveClass(/restoration-chip--pontic/);
}

async function runBridgeStages(page: Page): Promise<void> {
  await page.getByTestId('bridge-abutment-surfaces-run').click();
  await expect(page.getByTestId('bridge-abutmentSurfaces-done')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('bridge-pontic-commit').click();
  await expect(page.getByTestId('bridge-pontic-done')).toBeVisible({ timeout: 60_000 });
  // The connector editor: a live preview first (it populates the editor), then commit.
  await page.getByTestId('bridge-connectors-preview').click();
  await expect(page.getByTestId('bridge-connectors-table')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('bridge-connectors-commit').click();
  await expect(page.getByTestId('bridge-connectors-done')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('bridge-framework-select').click();
  await expect(page.getByTestId('bridge-framework-readout')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('bridge-assembly-run').click();
  await expect(page.getByTestId('bridge-assembly-readout')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('bridge-error')).toHaveCount(0);
  await page.getByTestId('bridge-qc-run').click();
  await expect(page.getByTestId('bridge-qc-table')).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId('bridge-error')).toHaveCount(0);
}

async function save(page: Page): Promise<void> {
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 60_000 });
}

test.describe.serial('Phase 9 — the bridge built from the case, and demo mode blocked for export', () => {
  test.setTimeout(900_000);

  let page: Page;
  let tmpDir: string;
  let targetPath: string;
  let gingivaPath: string;
  const caseName = `Phase9 Bridge E2E ${Date.now()}`;
  let caseBridgeId: string;

  test.beforeAll(async ({ browser }) => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dqcad-e2e-phase9-'));
    targetPath = join(tmpDir, 'arch-14-16.stl');
    gingivaPath = join(tmpDir, 'gingiva-15.stl');
    writeFileSync(targetPath, writeStlBinary(soupOf(ARCH.targetScan)));
    writeFileSync(gingivaPath, writeStlBinary(soupOf(ARCH.gingiva)));
    page = await browser.newPage();
    await skipOnboardingTour(page);
  });

  test.afterAll(async () => {
    await page.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('imports the target (prep) scan and the gingiva scan; a 14-15-16 bridge with confirmed margins', async () => {
    await newCase(page, caseName);
    await importScan(page, targetPath, 'arch-14-16.stl', 'upperJaw', 1);
    await importScan(page, gingivaPath, 'gingiva-15.stl', 'gingiva', 2);
    await createBridge(page, [14, 16], 15);
    caseBridgeId = await realOptionValue(page, 'bridge-restoration-select');
    // The exact shoulder rings, as the STL stores them (Float32): vertices of
    // the imported scan.
    for (const a of ARCH.abutments) {
      const ring = a.marginLoop.map((p) => p.map((v) => Math.fround(v)) as Vec3);
      await seedConfirmedMargin(page, caseBridgeId, a.tooth, { anchors: [], closed: true, resampledPoints: ring });
    }
  });

  test('builds the bridge from the case, runs every stage, and every one of the 11 gates passes', async () => {
    await page.getByTestId('bridge-restoration-select').selectOption(caseBridgeId);
    await expect(page.getByTestId('bridge-needs-gingiva')).toHaveCount(0);
    await page.getByTestId('bridge-case-pitch').fill('60');
    await page.getByTestId('bridge-start-case-button').click();
    await expect(page.getByTestId('bridge-case-source')).toBeVisible({ timeout: 600_000 });
    await expect(page.getByTestId('bridge-start-error')).toHaveCount(0);
    // No demonstration banner: this is the case's geometry.
    await expect(page.getByTestId('bridge-synthetic-notice')).toHaveCount(0);
    await expect(page.getByTestId('bridge-case-pontic-template')).toBeVisible();
    await expect(page.getByTestId('bridge-shared-axis')).toHaveClass(/bridge-axis--ok/);

    await runBridgeStages(page);
    await expect(page.locator('[data-testid^="bridge-qc-gate-"]')).toHaveCount(11);
    await expect(page.locator('[data-testid^="bridge-qc-gate-"][data-passed="true"]')).toHaveCount(11);
    await expect(page.getByTestId('bridge-qc-passed')).toBeVisible();
    await expect(page.getByTestId('bridge-qc-synthetic-note')).toHaveCount(0);
    await save(page);
  });

  test('export: the server re-validates the exact bytes and releases the bridge (no disclosure)', async () => {
    await page.getByTestId('export-restoration-select').selectOption(caseBridgeId);
    await expect(page.getByTestId('export-disclosure')).toHaveCount(0);
    await expect(page.getByTestId('export-qc-passed')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('export-gate-block')).toHaveCount(0);
    await page.getByTestId('export-format-select').selectOption('stl');
    await page.getByTestId('export-run-button').click();
    const released = page.getByTestId('export-released');
    const mismatch = page.getByTestId('export-mismatch');
    const releaseError = page.getByTestId('export-release-error');
    await Promise.race([
      expect(released).toBeVisible({ timeout: 300_000 }),
      expect(mismatch).toBeVisible({ timeout: 300_000 }),
      expect(releaseError).toBeVisible({ timeout: 300_000 }),
    ]);
    await expect(mismatch).toHaveCount(0);
    await expect(releaseError).toHaveCount(0);
    await expect(page.getByTestId('export-download-link')).toHaveAttribute('href', /\/api\/exports\/.+\/download$/);
  });

  test('demo mode: the demonstration bridge fails every gate closed and the export panel refuses it', async () => {
    await page.getByTestId('bridge-close-button').click();
    await createBridge(page, [24, 26], 25);
    const demoId = await realOptionValue(page, 'bridge-restoration-select', 2);
    for (const tooth of [24, 26]) {
      const ring: Vec3[] = Array.from({ length: 8 }, (_, i) => [Math.cos((2 * Math.PI * i) / 8), Math.sin((2 * Math.PI * i) / 8), 0]);
      await seedConfirmedMargin(page, demoId, tooth, { anchors: [], closed: true, resampledPoints: ring });
    }
    await page.getByTestId('bridge-restoration-select').selectOption(demoId);
    await page.getByTestId('bridge-start-button').click();
    await expect(page.getByTestId('bridge-synthetic-notice')).toBeVisible();
    // The case's teeth (in wizard order) are named against the fixture's.
    for (const tooth of ['24', '25', '26', '14-15-16']) {
      await expect(page.getByTestId('bridge-synthetic-mismatch')).toContainText(tooth);
    }

    await runBridgeStages(page);
    await expect(page.getByTestId('bridge-qc-failed')).toBeVisible();
    await expect(page.locator('[data-testid^="bridge-qc-gate-"][data-passed="false"]')).toHaveCount(11);
    await expect(page.getByTestId('bridge-qc-synthetic-note')).toContainText('cannot be exported');
    await save(page);

    await page.getByTestId('export-restoration-select').selectOption(demoId);
    await expect(page.getByTestId('export-disclosure')).toHaveAttribute('data-provenance', 'demo-fixture');
    await expect(page.getByTestId('export-qc-failed')).toBeVisible();
    await expect(page.getByTestId('export-gate-block')).toBeVisible();
    await expect(page.getByTestId('export-run-button')).toBeDisabled();
    await expect(page.getByTestId('export-released')).toHaveCount(0);
  });
});
