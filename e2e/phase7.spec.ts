import { expect, test, type Download, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeMesh, intake, buildBvh, snapToSurface, type IndexedMesh } from '@dqcad/kernel';
import { parseStl, writeStlBinary, type RawTriangleSoup } from '@dqcad/io';

// Phase 7 Task 9 acceptance walkthrough (docs/plans/phase-7-export.md's Task 9
// brief): the export & manufacturing-handoff workflow END TO END through the
// REAL UI -- a fully designed crown restoration (import -> margin -> crown
// design -> QC) is carried into the export panel and:
//   * the export is BLOCKED while a failing gate is unacknowledged (the honest-
//     failure surface: a buttonless, i18n'd block, NO retry-to-green) -- ADR-014
//     synthetic-data disclosure asserted present;
//   * the failing gates are acknowledged (the REAL journaled acknowledge flow);
//   * export -> the client journaled export -> the SERVER independent
//     re-validation on the exact exported bytes -> a RELEASED file (real
//     download link) + the QC traceability doc (HTML view + JSON download);
//   * the released bytes are re-downloaded and re-imported watertight/manifold
//     (Phase-7 acceptance criterion 1) through the real @dqcad/io parser;
//   * the case archive is exported (.dqca) and re-imported -- the import
//     CONFIRMS before overwriting an existing case (invariant 5, no silent
//     mutation) and, once confirmed, surfaces the `importedUnverified`
//     provenance line (the T6 F-B1 integrity-not-authenticity trust boundary
//     made visible to the user).
//
// Same "real file input, real WebGL canvas, real worker jobs (incl. the
// manifold-3d WASM path), real server routes, real save/reload, not mocked at
// any layer" standard as e2e/phase{1,3,4,5,6}.spec.ts. The server re-validation
// (T4), the traceability generation (T5), the outer-envelope certification +
// finalMesh persistence (T6/T8), and the archive round-trip (T6) all run for
// real behind the panel -- this spec is the FIRST real-browser proof they wire
// together through the product export UI, not just in the T8 harness.
//
// ## Why a synthetic shoulder-margin die (identical reasoning to phase4.spec.ts)
//
// The REAL arch-case-01 tooth-11 crown is UNBUILDABLE end to end (it blocks at
// the shell on real-scan input quality -- see e2e/phase4.spec.ts's top doc and
// docs/demos/phase-4.md). Driving an export e2e needs a restoration that
// actually completes to a finalMesh + QC report, so this spec re-derives
// phase4.spec.ts's small, clean, buildable shoulder-margin solid of revolution
// (profile + revolve + corner-refinement) and drives the complete product UI
// against it -- crown-design itself is the real coupled controller + worker
// jobs, nothing test-assisted downstream of the margin seed. The whole phase is
// fixture-proven exactly like Phases 5 and 6 (docs/demos/phase-7.md's headline);
// the real-scan certifications stay TRACKED-PENDING.
//
// ## The gate-block IS the honest-failure surface this spec proves live
//
// The live crown-design QC genuinely FAILS minWallThickness + seating at the
// razor-thin cervical seam (the SAME finding phase4.spec.ts measured: the
// client `runQc()` does not pass `marginExclusionMm`, so the seam samples
// razor-thin and honestly fails). That is not routed around -- it is exactly
// the material for the gate-BLOCK segment: BEFORE the gates are acknowledged the
// export panel REFUSES export (`export-gate-block`, the export button disabled,
// nothing POSTed), and there is no affordance to "retry until it passes".
//
// ## A real gap this spec surfaced -- now RESOLVED (the profileVersion mismatch)
//
// Driving the export through the REAL UI (not the T8 harness) revealed a genuine
// dual-validation catch the fixture harness had masked: a freshly created case
// has EMPTY `settings`, so the client design engines used to stamp
// `QcReport.profileVersion: 'unversioned'` while the export request/server
// resolve the profile to standard-zirconia 1.4.0 -- so the server's independent
// re-validation HONESTLY refused `export-qc-mismatch` on the `profileVersion`
// field for EVERY real-UI export. The Task 9 fix round closed it at the root:
// the QC stamp and the export path now share ONE resolver
// (engine/materialProfile.ts), so an empty-settings case stamps
// standard-zirconia 1.4.0 consistently and a fresh-case export RELEASES with no
// setup -- proven by this spec releasing from a plain new case (no profile seed).
// The live multi-material PICKER remains the tracked carry-in
// (docs/demos/phase-7.md open item 3). The server-mismatch diagnostic surface
// itself (the per-field diff + diagnostic id, no retry button) is proven by
// `ExportPanel.dom.test.tsx`'s browser-lane tests; a genuine mismatch is not
// re-forced here so the released-file happy path stays deterministic.
const GINGIVAL_R_MM = 4.5;
const MARGIN_R_MM = 4.0;
const TOP_R_MM = 2.5;
const MARGIN_Z_MM = 1.5;
const TOP_Z_MM = 9.0;
const SEGMENTS = 128;
const CORNER_REFINEMENT_MM = 0.05;
const SEED_HEIGHT_ABOVE_MARGIN_MM = 1.0;

const CROWN_TOOTH = '11';

type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];

function sub2(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}
function normalize2(v: Vec2): Vec2 {
  const len = Math.hypot(v[0], v[1]);
  return [v[0] / len, v[1] / len];
}
/** `6 * signed volume` (divergence theorem) -- re-derived locally, same as
 * e2e/phase4.spec.ts's identical helper. */
function sixSignedVolume(positions: readonly Vec3[], triangles: readonly (readonly [number, number, number])[]): number {
  let sum = 0;
  for (const [ia, ib, ic] of triangles) {
    const a = positions[ia]!;
    const b = positions[ib]!;
    const c = positions[ic]!;
    sum += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return sum;
}
function ensureOutwardWinding(
  positions: readonly Vec3[],
  triangles: readonly (readonly [number, number, number])[],
): (readonly [number, number, number])[] {
  if (sixSignedVolume(positions, triangles) >= 0) return triangles.slice();
  return triangles.map(([a, b, c]) => [a, c, b] as const);
}
function meshFromLists(positions: readonly Vec3[], triangles: readonly (readonly [number, number, number])[]): IndexedMesh {
  const flatPositions = new Float64Array(positions.length * 3);
  positions.forEach((p, i) => flatPositions.set(p, i * 3));
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((t, i) => indices.set(t, i * 3));
  return { positions: flatPositions, indices };
}
/** Revolves a (r,z) profile polyline around the Z axis into a closed watertight
 * solid -- re-derivation of e2e/phase4.spec.ts's `revolveProfile`. */
function revolveProfile(profile: readonly Vec2[], segments: number): IndexedMesh {
  const ringCount = profile.length;
  const positions: Vec3[] = [];
  const ringIndex = (ring: number, seg: number): number => ring * segments + seg;
  for (let r = 0; r < ringCount; r++) {
    const [radius, z] = profile[r]!;
    for (let s = 0; s < segments; s++) {
      const theta = (2 * Math.PI * s) / segments;
      positions.push([radius * Math.cos(theta), radius * Math.sin(theta), z]);
    }
  }
  const bottomCenterIndex = positions.length;
  positions.push([0, 0, profile[0]![1]]);
  const topCenterIndex = positions.length;
  positions.push([0, 0, profile[ringCount - 1]![1]]);

  const triangles: [number, number, number][] = [];
  for (let r = 0; r < ringCount - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const sNext = (s + 1) % segments;
      const a = ringIndex(r, s);
      const b = ringIndex(r, sNext);
      const c = ringIndex(r + 1, sNext);
      const d = ringIndex(r + 1, s);
      triangles.push([a, b, c]);
      triangles.push([a, c, d]);
    }
  }
  for (let s = 0; s < segments; s++) {
    const sNext = (s + 1) % segments;
    triangles.push([bottomCenterIndex, ringIndex(0, sNext), ringIndex(0, s)]);
  }
  for (let s = 0; s < segments; s++) {
    const sNext = (s + 1) % segments;
    triangles.push([topCenterIndex, ringIndex(ringCount - 1, s), ringIndex(ringCount - 1, sNext)]);
  }
  return meshFromLists(positions, ensureOutwardWinding(positions, triangles));
}
/** The buildable synthetic prep die -- a shoulder-margin solid of revolution
 * (bbox largest extent 9 mm > the client's 8 mm unit-suspect threshold, so no
 * rescale dialog). See e2e/phase4.spec.ts's top doc. */
function buildShoulderPrepDie(): IndexedMesh {
  const p0: Vec2 = [GINGIVAL_R_MM, 0];
  const p1: Vec2 = [GINGIVAL_R_MM, MARGIN_Z_MM];
  const p2: Vec2 = [MARGIN_R_MM, MARGIN_Z_MM];
  const p3: Vec2 = [TOP_R_MM, TOP_Z_MM];
  const preP2: Vec2 = [p2[0] + CORNER_REFINEMENT_MM, p2[1]];
  const taperDir = normalize2(sub2(p3, p2));
  const postP2: Vec2 = [p2[0] + taperDir[0] * CORNER_REFINEMENT_MM, p2[1] + taperDir[1] * CORNER_REFINEMENT_MM];
  const profile: Vec2[] = [p0, p1, preP2, p2, postP2, p3];
  return revolveProfile(profile, SEGMENTS);
}
/** Un-indexes an `IndexedMesh` into triangle-soup form for `writeStlBinary`. */
function toTriangleSoup(mesh: IndexedMesh): RawTriangleSoup {
  const triangleCount = mesh.indices.length / 3;
  const positions = new Float64Array(triangleCount * 9);
  for (let t = 0; t < triangleCount; t++) {
    for (let v = 0; v < 3; v++) {
      const vi = mesh.indices[t * 3 + v]!;
      const outBase = t * 9 + v * 3;
      positions[outBase] = mesh.positions[vi * 3]!;
      positions[outBase + 1] = mesh.positions[vi * 3 + 1]!;
      positions[outBase + 2] = mesh.positions[vi * 3 + 2]!;
    }
  }
  return { positions, normals: null, triangleCount };
}
/** Computes the margin-propose SEED (triangleIndex + barycentric) the SAME way
 * e2e/phase4.spec.ts does: read the exact bytes just written, run the real
 * parseStl -> intake pipeline, snapToSurface a point on the taper wall just
 * above the margin. Only "which triangle did a click ray hit" is skipped. */
function computeMarginSeed(stlPath: string): { triangleIndex: number; barycentric: [number, number, number] } {
  const rawBytes = readFileSync(stlPath);
  const { soup } = parseStl(new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength));
  const mesh = intake({ kind: 'soup', soup }).mesh;
  const bvh = buildBvh(mesh);
  const seedZ = MARGIN_Z_MM + SEED_HEIGHT_ABOVE_MARGIN_MM;
  const seedR = MARGIN_R_MM + ((TOP_R_MM - MARGIN_R_MM) * SEED_HEIGHT_ABOVE_MARGIN_MM) / (TOP_Z_MM - MARGIN_Z_MM);
  const seed = snapToSurface(mesh, bvh, [seedR, 0, seedZ]);
  return { triangleIndex: seed.triangleIndex, barycentric: seed.barycentric as [number, number, number] };
}
/** Thin wrapper around `window.__dqcadTestHooks__.seedMarginPropose` -- the same
 * DEV-only bridge e2e/phase{3,4}.spec.ts use. */
async function seedMarginPropose(
  page: Page,
  triangleIndex: number,
  barycentric: readonly [number, number, number],
): Promise<void> {
  await page.evaluate(
    async ({ triangleIndex, barycentric }) => {
      const hooks = (
        window as unknown as {
          __dqcadTestHooks__?: {
            seedMarginPropose: (ti: number, bc: readonly [number, number, number]) => Promise<void>;
          };
        }
      ).__dqcadTestHooks__;
      if (!hooks) throw new Error('seedMarginPropose: __dqcadTestHooks__ missing');
      await hooks.seedMarginPropose(triangleIndex, barycentric);
    },
    { triangleIndex, barycentric },
  );
}
/** Saves a Playwright download to a temp path and returns the bytes -- used to
 * round-trip the released STL and the .dqca archive back through the real
 * @dqcad/io parser / the archive-import file input. */
async function saveDownload(download: Download, dir: string, name: string): Promise<Uint8Array> {
  const path = join(dir, name);
  await download.saveAs(path);
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

test.describe.serial('Phase 7 export & manufacturing-handoff workflow (buildable synthetic crown, real UI)', () => {
  test.setTimeout(600_000);

  let page: Page;
  let tmpDir: string;
  let diePath: string;
  const caseName = `Phase7 E2E ${Date.now()}`;
  let restorationLabel: string; // "Crown (11)" -- the export select option text

  test.beforeAll(async ({ browser }) => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dqcad-e2e-phase7-'));
    diePath = join(tmpDir, 'shoulder-prep-die.stl');
    writeFileSync(diePath, writeStlBinary(toTriangleSoup(buildShoulderPrepDie())));
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates a case, imports the die, designs a crown to a finalMesh (failing QC)', async () => {
    await page.goto('/');
    await expect(page.getByTestId('app-title')).toHaveText('DQ Dental CAD');

    await page.getByTestId('open-case-picker-button').click();
    await expect(page.getByTestId('case-picker')).toBeVisible();
    await page.getByTestId('case-picker-new-case-name').fill(caseName);
    await page.getByTestId('case-picker-new-case-name').press('Enter');
    await expect(page.getByTestId('case-picker')).toBeHidden();
    await expect(page.getByTestId('active-case-name')).toHaveText(caseName);

    // NB: a freshly created case needs NO material-profile setup here. The
    // client QC stamp and the export path now share ONE resolver
    // (engine/materialProfile.ts `resolveProfileVersion` / `resolveMaterialProfile`),
    // so an empty-settings case stamps standard-zirconia 1.4.0 consistently and
    // the server's dual re-validation agrees -- the real-UI export releases from
    // a fresh case (the Task 9 fix round; see docs/demos/phase-7.md open item 3).

    await page.getByTestId('import-file-input').setInputFiles(diePath);
    const row = page.getByTestId('import-file-row').filter({ hasText: 'shoulder-prep-die.stl' });
    await expect(row.getByTestId('import-role-select')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('unit-confirm-keep-mm')).toHaveCount(0);
    await row.getByTestId('import-role-select').selectOption('prepDie');
    await expect(page.getByTestId('scene-tree-row')).toHaveCount(1);

    // Wizard: crown on tooth 11.
    await page.getByTestId('restoration-type-crown').click();
    await page.getByTestId(`fdi-tooth-${CROWN_TOOTH}`).click();
    await page.getByTestId('restoration-target-select').selectOption({ index: 1 });
    await expect(page.getByTestId('restoration-submit-button')).toBeEnabled();
    await page.getByTestId('restoration-submit-button').click();
    await expect(page.getByTestId(`restoration-chip-${CROWN_TOOTH}`)).toBeVisible();

    // Margin: seeded auto-propose on the shoulder die, accept + confirm.
    const seed = computeMarginSeed(diePath);
    await page.getByTestId('margin-restoration-select').selectOption({ index: 1 });
    await page.getByTestId('margin-tooth-select').selectOption(CROWN_TOOTH);
    await page.getByTestId('margin-start-button').click();
    await expect(page.getByTestId('margin-mode-selector')).toBeVisible();
    await seedMarginPropose(page, seed.triangleIndex, seed.barycentric);
    await expect(page.getByTestId('margin-anchor-count')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('margin-error')).toHaveCount(0);
    await page.getByTestId('margin-accept-button').click();
    await expect(page.getByTestId('margin-validation-badge')).toHaveAttribute('data-status', /^(valid|warning)$/, {
      timeout: 15_000,
    });
    const confirmButton = page.getByTestId('margin-confirm-button');
    await expect(confirmButton).toBeEnabled({ timeout: 15_000 });
    await confirmButton.click();
    const acknowledgeButton = page.getByTestId('margin-acknowledge-confirm-button');
    const confirmedIndicator = page.getByTestId('margin-confirmed-indicator');
    await Promise.race([
      expect(acknowledgeButton).toBeVisible({ timeout: 15_000 }),
      expect(confirmedIndicator).toBeVisible({ timeout: 15_000 }),
    ]);
    if (await acknowledgeButton.isVisible()) await acknowledgeButton.click();
    await expect(confirmedIndicator).toBeVisible({ timeout: 15_000 });

    // Crown design: inner -> anatomy -> morph -> shell -> freeform -> QC.
    await page.getByTestId('crown-restoration-select').selectOption({ index: 1 });
    await page.getByTestId('crown-start-button').click();
    await expect(page.getByTestId('crown-panel')).toBeVisible();

    await page.getByTestId('crown-inner-pitch').fill('150');
    await page.getByTestId('crown-inner-run').click();
    await expect(page.getByTestId('crown-inner-readout')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('crown-error')).toHaveCount(0);

    await page.getByTestId('crown-anatomy-autoplace').click();
    await expect(page.getByTestId('crown-anatomy-readout')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('crown-error')).toHaveCount(0);

    await page.getByTestId('crown-morph-run').click();
    await expect(page.getByTestId('crown-morph-readout')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('crown-error')).toHaveCount(0);

    await page.getByTestId('crown-shell-construct').click();
    await Promise.race([
      expect(page.getByTestId('crown-shell-readout')).toBeVisible({ timeout: 120_000 }),
      expect(page.getByTestId('crown-error')).toBeVisible({ timeout: 120_000 }),
    ]);
    await expect(page.getByTestId('crown-error')).toHaveCount(0);
    await expect(page.getByTestId('crown-shell-readout')).toContainText('✓');
    await expect(page.getByTestId('crown-shell-done')).toBeVisible();

    // NOTE (deliberate, see docs/demos/phase-7.md): the freeform sculpt stage
    // is intentionally SKIPPED. The shell's finalMesh is a manifold-3d (WASM)
    // boolean output whose geometry-gate measurements are narrowing-stable
    // (measured this session: the server's dual re-validation agreed on EVERY
    // geometry gate over the re-imported bytes -- only the profileVersion
    // metadata field diverged, which the seeded material profile above fixes).
    // A freeform stroke adds an f64 displacement that is NOT f32-representable;
    // on this razor-thin cervical seam the sub-micron narrowing could move a
    // geometry gate value and trip the exact-equality QC diff (the honest-
    // failure `export-qc-mismatch` surface -- itself proven by
    // ExportPanel.dom.test.tsx). Skipping it keeps the released-file happy path
    // deterministic so acceptance criteria 1+2 are provable through the real
    // released-file link.

    // QC: genuinely FAILS minWallThickness + seating at the cervical seam (the
    // phase4 finding). Assert the honest FAIL -- do NOT acknowledge yet (the
    // gate-block segment below needs the failing, unacknowledged report).
    await page.getByTestId('crown-qc-run').click();
    await expect(page.getByTestId('crown-qc-table')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('crown-error')).toHaveCount(0);
    await expect(page.locator('[data-testid^="crown-qc-gate-"]')).toHaveCount(8);
    await expect(page.getByTestId('crown-qc-failed')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator('[data-testid^="crown-qc-gate-"][data-passed="false"] [data-testid^="crown-qc-ack-"]'),
    ).not.toHaveCount(0);

    // Save so the finalMesh + QC report persist (the export panel reads the
    // committed restoration; the release also re-saves + uploads the finalMesh).
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 30_000 });
  });

  test('export panel: BLOCKS export while a failing gate is unacknowledged (honest-failure, no retry-to-green)', async () => {
    await expect(page.getByTestId('export-panel')).toBeVisible();

    // --- ADR-014 DISCLOSURE PROOF: the synthetic-data banner rides the panel ---
    await expect(page.getByTestId('export-disclosure')).toBeVisible();

    // Select the crown restoration (first real option). Capture its label so we
    // can re-select it after reload later if needed.
    const option = page.locator('[data-testid="export-restoration-select"] option').nth(1);
    restorationLabel = (await option.textContent())?.trim() ?? '';
    expect(restorationLabel).toContain('11');
    await page.getByTestId('export-restoration-select').selectOption({ index: 1 });

    // The QC recap renders the failing report; the export is BLOCKED.
    await expect(page.getByTestId('export-qc-failed')).toBeVisible();
    await expect(page.getByTestId('export-qc-recap')).toBeVisible();
    const block = page.getByTestId('export-gate-block');
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute('role', 'alert');
    // The honest-failure discipline: the export button is DISABLED -- no
    // "retry until it passes" affordance, and nothing has been released.
    await expect(page.getByTestId('export-run-button')).toBeDisabled();
    await expect(page.getByTestId('export-released')).toHaveCount(0);
    await expect(page.getByTestId('export-releasing')).toHaveCount(0);
  });

  test('acknowledge the failing gates (real journaled flow) -> export becomes allowed', async () => {
    // Acknowledge exactly whichever gates genuinely failed, in the crown panel
    // (the REAL, journaled acknowledge action -- invariant 4: the gate keeps
    // reporting passed=false, the report's overall passed flips true).
    const pendingAckButtons = page.locator(
      '[data-testid^="crown-qc-gate-"][data-passed="false"] [data-testid^="crown-qc-ack-"]',
    );
    let pendingCount = await pendingAckButtons.count();
    while (pendingCount > 0) {
      await pendingAckButtons.first().click();
      await expect(pendingAckButtons).toHaveCount(pendingCount - 1, { timeout: 30_000 });
      pendingCount = await pendingAckButtons.count();
    }
    await expect(page.getByTestId('crown-qc-passed')).toBeVisible({ timeout: 15_000 });

    // Save the acknowledged case so the release re-validates the journaled acks.
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 30_000 });

    // The export panel's recap now shows an all-pass (acknowledged) report and
    // the export button is enabled (no gate-block).
    await expect(page.getByTestId('export-qc-passed')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('export-gate-block')).toHaveCount(0);
    await expect(page.getByTestId('export-run-button')).toBeEnabled();
  });

  test('export -> server re-validation -> released file + traceability doc (HTML + JSON)', async () => {
    await expect(page.getByTestId('export-format-select')).toBeVisible();
    await page.getByTestId('export-format-select').selectOption('stl');

    await page.getByTestId('export-run-button').click();

    // The release runs the client journaled export -> POST /export (the SERVER
    // independently re-validates the exact bytes: re-import, re-run every gate,
    // outer-envelope certify, generate traceability) -> 'released'. Branch on
    // the real outcome so a genuine mismatch fails loudly rather than hanging.
    const released = page.getByTestId('export-released');
    const mismatch = page.getByTestId('export-mismatch');
    const releaseError = page.getByTestId('export-release-error');
    await Promise.race([
      expect(released).toBeVisible({ timeout: 120_000 }),
      expect(mismatch).toBeVisible({ timeout: 120_000 }),
      expect(releaseError).toBeVisible({ timeout: 120_000 }),
    ]);
    // The server AGREED (dual validation passed on the exact bytes) -- a release,
    // not the honest-failure surface.
    await expect(mismatch).toHaveCount(0);
    await expect(releaseError).toHaveCount(0);
    await expect(released).toBeVisible();

    // The released card carries the real download link + BOTH traceability
    // links (HTML view + JSON download), all with server hrefs.
    const downloadLink = page.getByTestId('export-download-link');
    await expect(downloadLink).toBeVisible();
    await expect(downloadLink).toHaveAttribute('href', /\/api\/exports\/.+\/download$/);
    await expect(page.getByTestId('export-traceability-html')).toHaveAttribute(
      'href',
      /\/api\/exports\/.+\/traceability\.html\?lang=(en|hu|de|es)$/,
    );
    await expect(page.getByTestId('export-traceability-json')).toHaveAttribute(
      'href',
      /\/api\/exports\/.+\/traceability\.json$/,
    );
    await expect(page.getByTestId('export-released-hash')).toBeVisible();
  });

  test('the released STL re-downloads + re-imports watertight/manifold (acceptance criterion 1)', async () => {
    // Download the EXACT released bytes and re-import them through the real
    // @dqcad/io parser + kernel intake -- Phase-7 acceptance criterion 1
    // proven through the real released-file link.
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-download-link').click();
    const download = await downloadPromise;
    const bytes = await saveDownload(download, tmpDir, 'released-crown.stl');
    expect(bytes.byteLength).toBeGreaterThan(84); // STL header + at least 1 facet

    const { soup } = parseStl(bytes);
    const result = intake({ kind: 'soup', soup });
    // A single watertight, manifold, single-component solid -- the acceptance
    // property, measured on the actual downloaded bytes (analyzeMesh, the same
    // topology analysis the intake + QC gates use).
    const stats = analyzeMesh(result.mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
    expect(stats.componentCount).toBe(1);

    // The traceability JSON is fetchable + schema-shaped: certified release doc.
    const jsonHref = await page.getByTestId('export-traceability-json').getAttribute('href');
    expect(jsonHref).toBeTruthy();
    const doc = await page.evaluate(async (href) => {
      const res = await fetch(href!);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }, jsonHref);
    expect(doc.status).toBe(200);
    expect(doc.body.documentKind).toBe('release');
    expect(doc.body.schemaVersion).toBe(2);
    expect((doc.body.certification as { outerEnvelopeCertified: boolean }).outerEnvelopeCertified).toBe(true);
  });

  test('case archive: export .dqca, re-import CONFIRMS overwrite (invariant 5) + shows importedUnverified provenance', async () => {
    // Export the case archive (a fire-once .dqca download).
    const archiveDownloadPromise = page.waitForEvent('download');
    await page.getByTestId('archive-export-button').click();
    const archiveDownload = await archiveDownloadPromise;
    const archiveBytes = await saveDownload(archiveDownload, tmpDir, 'case.dqca');
    // DQCA container magic: the little-endian uint32 0x41434451 at offset 0
    // (case-archive.ts CASE_ARCHIVE_MAGIC — on-disk bytes 0x51 0x44 0x43 0x41).
    const magic = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, 4).getUint32(0, true);
    expect(magic).toBe(0x41434451);
    const archivePath = join(tmpDir, 'case.dqca');

    // Re-importing over the SAME case id must NOT silently overwrite: the server
    // returns 409 archive-import-conflict, surfaced as a confirm prompt.
    await page.getByTestId('archive-import-input').setInputFiles(archivePath);
    await expect(page.getByTestId('archive-conflict')).toBeVisible({ timeout: 30_000 });

    // Confirm the overwrite (the real invariant-5 user gesture) -> imported.
    await page.getByTestId('archive-conflict-confirm').click();
    const imported = page.getByTestId('archive-imported');
    await expect(imported).toBeVisible({ timeout: 30_000 });

    // The imported case carried the released Export row -> the T6 F-B1 trust
    // boundary is made visible: the importedUnverified provenance line renders
    // ("this server did NOT independently re-validate them").
    await expect(page.getByTestId('archive-imported-provenance')).toBeVisible();
    await page.getByTestId('archive-dismiss').click();
  });
});
