import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeMesh, intake, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
import { openArchPrepCase } from '@dqcad/kernel/die-fixtures';
import { parseStl, writeStlBinary, type RawTriangleSoup } from '@dqcad/io';
import { skipOnboardingTour } from './support';

// Phase 10 Task 6 — THE PHASE GATE (docs/plans/phase-10-crown-on-the-real-scan.md,
// phase acceptance 1, 2 and 4): a crown on an OPEN scan, through the real UI,
// with EVERY crown gate passing and the export RELEASED after the server has
// re-extracted the die.
//
// The input is the closed-form open-arch prep case (kernel
// die/die.test-fixtures.ts `openArchPrepCase`, the fixture of
// test/golden/crown-open-arch-acceptance.test.ts): a shouldered prep die and
// two neighbour crowns on an open gingival sheet with a base cut. It is
// written as binary STL and imported through the file input, as a scan is.
// The crown is on premolar 15 (the golden's library lane, the Task 4
// decision: the round die is a premolar-shaped preparation).
//
// The walkthrough: import → crown → margin → axis (the real axis tool) →
// **Prepare die** (certified, journaled) → intaglio → capture both
// neighbours from the scan (one canvas pick each) → the fitted LIBRARY
// template (the default, `crown-cervical-fit` journaled) → morph → shell → QC
// with all eight gates passing and NO acknowledgement → save → export → the
// server re-validates the exact bytes and re-extracts the die from the saved
// scan, margin and axis → released → the released STL re-imports watertight.
//
// ## Seeded input
//
// Only the margin: the fixture's exact margin ring (scan vertices), via the
// DEV-only `seedConfirmedMargin` hook, as e2e/phase9-crown seeds the real
// scan's reference trace. The die needs every margin point on the scan
// (Task 2's finding: within 0.1 µm of the kept surface), and the ring is the
// shoulder's inner crease by construction. The anchors carry the scan
// triangles at those vertices, which the axis tool reads for its region.

const CROWN_TOOTH = '15';
/** The intaglio pitch: the golden's (a journaled parameter). */
const INNER_PITCH_UM = '60';
const ANCHOR_STRIDE = 16;

const arch = openArchPrepCase();
const neighbours = arch.params.neighbours!;

function toTriangleSoup(mesh: IndexedMesh): RawTriangleSoup {
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

/** The scan as the app holds it: the exact STL bytes through the real
 * parseStl → intake (CLAUDE.md invariant 2: the browser's intake is
 * byte-identical). */
function importedScan(stlPath: string): IndexedMesh {
  const bytes = readFileSync(stlPath);
  const { soup } = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return intake({ kind: 'soup', soup }).mesh;
}

function nearestVertex(mesh: IndexedMesh, target: Vec3): number {
  let best = Infinity;
  let at = -1;
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const d = Math.hypot(
      mesh.positions[i * 3]! - target[0],
      mesh.positions[i * 3 + 1]! - target[1],
      mesh.positions[i * 3 + 2]! - target[2],
    );
    if (d < best) {
      best = d;
      at = i;
    }
  }
  return at;
}

function vertexAt(mesh: IndexedMesh, v: number): Vec3 {
  return [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
}

/** The confirmed margin on the imported scan: the fixture's margin ring as
 * the scan's own vertices, and every `ANCHOR_STRIDE`-th one as an anchor on a
 * triangle at that vertex (barycentric weight 1 on its corner). */
function marginOn(mesh: IndexedMesh): {
  anchors: { position: Vec3; triangleIndex: number; barycentric: Vec3 }[];
  closed: boolean;
  resampledPoints: Vec3[];
} {
  const vertices = arch.marginLoop.map((p) => nearestVertex(mesh, p));
  const resampledPoints = vertices.map((v) => vertexAt(mesh, v));
  const anchors = vertices
    .filter((_, i) => i % ANCHOR_STRIDE === 0)
    .map((v) => {
      for (let t = 0; t < mesh.indices.length / 3; t++) {
        for (let c = 0; c < 3; c++) {
          if (mesh.indices[t * 3 + c] !== v) continue;
          const barycentric: Vec3 = [c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0];
          return { position: vertexAt(mesh, v), triangleIndex: t, barycentric };
        }
      }
      throw new Error(`margin vertex ${v} has no triangle`);
    });
  return { anchors, closed: true, resampledPoints };
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

type OpView = { params: Record<string, unknown>; inputHashes: string[]; outputHashes: string[] };

test.describe.serial('Phase 10 — a crown on an open scan: every gate passes, the export is released', () => {
  test.setTimeout(900_000);

  let page: Page;
  let tmpDir: string;
  let scanPath: string;
  let scan: IndexedMesh;
  let restorationId: string;
  const caseName = `Phase10 E2E ${Date.now()}`;

  test.beforeAll(async ({ browser }) => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dqcad-e2e-phase10-'));
    scanPath = join(tmpDir, 'open-arch-prep-15.stl');
    writeFileSync(scanPath, writeStlBinary(toTriangleSoup(arch.scan)));
    scan = importedScan(scanPath);
    page = await browser.newPage();
    await skipOnboardingTour(page);
  });

  test.afterAll(async () => {
    await page.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('imports the open scan, a crown on 15 with its confirmed margin and insertion axis', async () => {
    expect(analyzeMesh(scan).watertight, 'the scan is open — the die must be closed synthetically').toBe(false);

    await page.goto('/');
    await page.getByTestId('open-case-picker-button').click();
    await page.getByTestId('case-picker-new-case-name').fill(caseName);
    await page.getByTestId('case-picker-new-case-name').press('Enter');
    await expect(page.getByTestId('active-case-name')).toHaveText(caseName);

    await page.getByTestId('import-file-input').setInputFiles(scanPath);
    const row = page.getByTestId('import-file-row').filter({ hasText: 'open-arch-prep-15.stl' });
    await expect(row.getByTestId('import-role-select')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('unit-confirm-keep-mm')).toHaveCount(0);
    await row.getByTestId('import-role-select').selectOption('upperJaw');
    await expect(page.getByTestId('scene-tree-row')).toHaveCount(1);

    await page.getByTestId('restoration-type-crown').click();
    await page.getByTestId(`fdi-tooth-${CROWN_TOOTH}`).click();
    await page.getByTestId('restoration-target-select').selectOption({ index: 1 });
    await page.getByTestId('restoration-submit-button').click();
    await expect(page.getByTestId(`restoration-chip-${CROWN_TOOTH}`)).toBeVisible();
    restorationId = (await page.locator('[data-testid="crown-restoration-select"] option').nth(1).getAttribute('value'))!;

    await hook(page, 'seedConfirmedMargin', restorationId, Number(CROWN_TOOTH), marginOn(scan));

    await page.getByTestId('axis-restoration-select').selectOption({ index: 1 });
    await page.getByTestId('axis-start-button').click();
    await page.getByTestId('axis-suggest-button').click();
    await expect(page.getByTestId('axis-abutment-table')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('axis-error')).toHaveCount(0);
    // The die is a height field over the XY-plane, so every direction near +Z
    // has zero undercut, and the suggestion's tie-break lands about 12° off
    // the die's own axis (docs/demos/phase-10.md, open item). The clinician
    // sets the path of insertion along the die with the elevation slider.
    await page.getByTestId('axis-elevation-slider').fill('90');
    await page.getByTestId('axis-confirm-button').click();
    await expect(page.getByTestId('axis-confirmed-indicator')).toBeVisible({ timeout: 10_000 });
    const axis = (await hook<Vec3 | null>(page, 'getRestorationAxis', restorationId))!;
    expect(axis[2]).toBeGreaterThan(1 - 1e-12);
  });

  test('Prepare die: the open scan is closed synthetically, certified and journaled; the intaglio is built on the die', async () => {
    await page.getByTestId('crown-restoration-select').selectOption(restorationId);
    await page.getByTestId('crown-start-button').click();
    await expect(page.getByTestId('crown-panel')).toBeVisible();

    await expect(page.getByTestId('crown-innerSurface-blocked')).toBeVisible();
    await page.getByTestId('crown-prepdie-run').click();
    await expect(page.getByTestId('crown-prepdie-readout')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('crown-error')).toHaveCount(0);
    await expect(page.getByTestId('crown-prepdie-certificate')).toContainText('µm');
    const dieOp = await hook<OpView>(page, 'getLatestOperation', 'crown-die-extract');
    expect(dieOp.params['restorationId']).toBe(restorationId);
    expect(dieOp.params['syntheticTriangleCount']).toBeGreaterThan(0);
    expect(dieOp.params['clearanceMm']).toBeGreaterThanOrEqual(dieOp.params['requiredClearanceMm'] as number);

    await page.getByTestId('crown-inner-pitch').fill(INNER_PITCH_UM);
    await page.getByTestId('crown-inner-run').click();
    await expect(page.getByTestId('crown-inner-readout')).toBeVisible({ timeout: 300_000 });
    await expect(page.getByTestId('crown-error')).toHaveCount(0);
    const innerOp = await hook<OpView>(page, 'getLatestOperation', 'crown-inner-surface');
    expect(innerOp.inputHashes[0]).toBe(dieOp.outputHashes[0]);
  });

  test('captures both neighbours from the scan with one canvas pick each', async () => {
    const canvas = page.locator('canvas');
    const box = (await canvas.boundingBox())!;
    for (const [side, x] of [
      ['mesial', -neighbours.centreMm],
      ['distal', neighbours.centreMm],
    ] as const) {
      // The top of the neighbour crown, as a scan vertex.
      const point = vertexAt(scan, nearestVertex(scan, [x, 0, neighbours.heightMm]));
      await page.getByTestId(`crown-capture-${side}-pick`).click();
      await expect(page.getByTestId(`crown-capture-${side}-hint`)).toBeVisible();
      const px = await hook<{ x: number; y: number } | null>(page, 'worldToCanvasPoint', point);
      expect(px, `${side} pick projects onto the canvas`).not.toBeNull();
      expect(px!.x).toBeGreaterThan(0);
      expect(px!.x).toBeLessThan(box.width);
      expect(px!.y).toBeGreaterThan(0);
      expect(px!.y).toBeLessThan(box.height);
      await page.mouse.click(box.x + px!.x, box.y + px!.y);
      await expect(page.getByTestId(`crown-capture-${side}-captured`)).toBeVisible({ timeout: 120_000 });
      await expect(page.getByTestId('crown-error')).toHaveCount(0);
      const op = await hook<OpView>(page, 'getLatestOperation', 'neighbour-capture');
      expect(op.params['side']).toBe(side);
      expect(op.params['restorationId']).toBe(restorationId);
    }
  });

  test('the fitted library template is placed (the default), the morph holds its ring, the shell trims along it', async () => {
    await page.getByTestId('crown-anatomy-autoplace').click();
    await expect(page.getByTestId('crown-anatomy-readout')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('crown-error')).toHaveCount(0);
    await expect(page.getByTestId('crown-anatomy-source')).toHaveAttribute('data-origin', 'library');
    await expect(page.getByTestId('crown-anatomy-cervical-fit')).toContainText('µm');
    const anatomyOp = await hook<OpView>(page, 'getLatestOperation', 'crown-anatomy');
    expect(anatomyOp.params['neighbourProvenance']).toBe('case');
    const fitOp = await hook<OpView>(page, 'getLatestOperation', 'crown-cervical-fit');
    expect(fitOp.inputHashes).toEqual([anatomyOp.outputHashes[0]]);
    expect(fitOp.params['errorBoundMm'] as number).toBeLessThanOrEqual(fitOp.params['maxResidualMm'] as number);

    await page.getByTestId('crown-morph-run').click();
    await expect(page.getByTestId('crown-morph-readout')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('crown-error')).toHaveCount(0);
    const morphOp = await hook<OpView>(page, 'getLatestOperation', 'crown-morph');
    expect(morphOp.params['fixedCervicalRingVertexCount']).toBe(fitOp.params['ringVertexCount']);

    await page.getByTestId('crown-shell-construct').click();
    await Promise.race([
      expect(page.getByTestId('crown-shell-readout')).toBeVisible({ timeout: 300_000 }),
      expect(page.getByTestId('crown-error')).toBeVisible({ timeout: 300_000 }),
    ]);
    await expect(page.getByTestId('crown-error')).toHaveCount(0);
    await expect(page.getByTestId('crown-shell-done')).toBeVisible();
    const shellOp = await hook<OpView>(page, 'getLatestOperation', 'crown-shell');
    expect(shellOp.params['cervicalRingTrim']).toBe(true);
  });

  test('QC: all eight gates pass on case geometry, with no acknowledgement', async () => {
    await page.getByTestId('crown-qc-run').click();
    await expect(page.getByTestId('crown-qc-table')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('crown-error')).toHaveCount(0);
    await expect(page.locator('[data-testid^="crown-qc-gate-"]')).toHaveCount(8);
    await expect(page.locator('[data-testid^="crown-qc-gate-"][data-passed="false"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="crown-qc-ack-"]')).toHaveCount(0);
    await expect(page.getByTestId('crown-qc-passed')).toBeVisible();

    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 30_000 });
  });

  test('export: no stand-in disclosure; the server re-extracts the die and re-validates the bytes; the file is released', async () => {
    await expect(page.getByTestId('export-panel')).toBeVisible();
    await page.getByTestId('export-restoration-select').selectOption({ index: 1 });
    // Every gate was measured on case geometry: no provenance banner.
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
    await expect(released).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-download-link').click();
    const download = await downloadPromise;
    const path = join(tmpDir, 'released-crown.stl');
    await download.saveAs(path);
    const bytes = readFileSync(path);
    const stats = analyzeMesh(
      intake({ kind: 'soup', soup: parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).soup }).mesh,
    );
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
    expect(stats.componentCount).toBe(1);

    const jsonHref = await page.getByTestId('export-traceability-json').getAttribute('href');
    const doc = await page.evaluate(async (href) => {
      const res = await fetch(href!);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }, jsonHref);
    expect(doc.status).toBe(200);
    expect(doc.body['documentKind']).toBe('release');
    expect((doc.body['certification'] as { outerEnvelopeCertified: boolean }).outerEnvelopeCertified).toBe(true);
  });
});
