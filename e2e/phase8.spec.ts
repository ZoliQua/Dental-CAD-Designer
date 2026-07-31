import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type IndexedMesh } from '@dqcad/kernel';
import { writeStlBinary, type RawTriangleSoup } from '@dqcad/io';

// Phase 8 Task 7 acceptance walkthrough (docs/plans/phase-8-polish-hardening.md,
// Task 7): the polish/hardening UX proven END TO END through the REAL UI, in a
// real Chromium browser, against an ISOLATED bootstrap (see the isolation note
// at the bottom — the P4-T13 incident: NEVER touch the developer's live dev
// server or edit committed server/port files). Same "real file input, real
// server routes, real save/reload, not mocked at any layer" standard as
// e2e/phase{1,3,4,5,6,7}.spec.ts.
//
// One describe.serial block shares ONE page + browser context so localStorage
// (the tour "seen" flag, the recovery marker) and the loaded case persist across
// steps and across the single simulated reload, exactly as a real session would.
//
// Coverage (say exactly what is covered):
//   1. ONBOARDING TOUR — first-run auto-open, dismiss (Skip → persist), and a
//      real reload proving it does NOT re-show (localStorage 'dqcad.tour.seen').
//   2. KEYBOARD SHORTCUT — the bare `?` chord fires help.shortcuts through the
//      single global dispatcher (useGlobalShortcuts → the action registry),
//      opening the shortcuts-help overlay; closed via its real close button.
//   3. COMMAND PALETTE — Cmd/Ctrl+K opens it; typing FILTERS the one registry
//      (a match stays, a non-match disappears); clicking an option RUNS that
//      action (help.shortcuts) and CLOSES the palette; Escape also closes it.
//   4. AUTH GATE (the now-real T6 gate, exercised HONESTLY) — the isolated
//      server runs with auth ENABLED (an explicit bootstrap token; see the
//      isolation note). A mutating POST WITHOUT the token is rejected 401
//      `auth-required`; the same-origin bootstrap (GET /api/auth/bootstrap)
//      yields the token; the POST WITH the token succeeds (201). The whole
//      real-UI flow below (create case, save/upload, PUT) also mutates
//      successfully, which only works because main.tsx's initAuth() bootstrapped
//      the token — a second, implicit proof the authed happy path works.
//   5. AUTOSAVE → SIMULATED RELOAD → RECOVERY — import a die, SAVE it (mesh
//      uploaded, fileHash stamped, snapshot cleared), then create a restoration
//      (an un-synced journaled edit the server never received), let the debounced
//      crash-safe snapshot commit, SIMULATE A CRASH (rewrite the marker's owning
//      sessionId so this page's pagehide can't mark it clean — the exact
//      unclean-shutdown condition), reload, and RESTORE. The restored case is
//      state-identical: the active case name AND the un-synced restoration chip
//      both come back (proving the local snapshot, not the older server state,
//      was recovered), with the die mesh reconstructed from the server (no
//      "incomplete" surface).
//   6. TELEMETRY-FREE ERROR BUNDLE — a synthetic window error raises the
//      non-blocking error surface; "Download diagnostic bundle" produces a LOCAL
//      file from a `blob:` object URL (NO http egress) whose JSON carries the app
//      + kernel versions but NOT the loaded case's name (no PHI) — the live
//      backing for diagnosticBundle.no-egress/.no-phi unit assertions.

// --- synthetic prep die (re-derived from e2e/phase4/phase7; bbox 9 mm > the 8 mm
// unit-suspect threshold, so NO rescale dialog). Only used by the recovery step
// as a valid importable scan; no crown is designed off it. ------------------
const GINGIVAL_R_MM = 4.5;
const MARGIN_R_MM = 4.0;
const TOP_R_MM = 2.5;
const MARGIN_Z_MM = 1.5;
const TOP_Z_MM = 9.0;
const SEGMENTS = 96;
const CORNER_REFINEMENT_MM = 0.05;
const RECOVERY_TOOTH = '11';

type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];

function sub2(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}
function normalize2(v: Vec2): Vec2 {
  const len = Math.hypot(v[0], v[1]);
  return [v[0] / len, v[1] / len];
}
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

const MARKER_KEY = 'dqcad.recovery.marker';
const TOUR_SEEN_KEY = 'dqcad.tour.seen';

test.describe.serial('Phase 8 polish & hardening UX (real UI, isolated bootstrap, auth ENABLED)', () => {
  test.setTimeout(300_000);

  let page: Page;
  let tmpDir: string;
  let diePath: string;
  const caseName = `Phase8 E2E ${Date.now()}`;

  test.beforeAll(async ({ browser }) => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dqcad-e2e-phase8-'));
    diePath = join(tmpDir, 'phase8-prep-die.stl');
    writeFileSync(diePath, writeStlBinary(toTriangleSoup(buildShoulderPrepDie())));
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('onboarding tour: first-run auto-open, dismiss + persist, no re-show after reload', async () => {
    await page.goto('/');
    await expect(page.getByTestId('app-title')).toHaveText('DQ Dental CAD');

    // First run: the tour auto-opens (the persisted seen flag is false).
    const tour = page.getByTestId('onboarding-tour');
    await expect(tour).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('onboarding-tour-progress')).toContainText('1');
    // The flag is not yet persisted (only finish/skip persists it).
    expect(await page.evaluate((k) => window.localStorage.getItem(k), TOUR_SEEN_KEY)).not.toBe('true');

    // Dismiss via Skip → marks seen (persisted).
    await page.getByTestId('onboarding-tour-skip').click();
    await expect(tour).toBeHidden();
    expect(await page.evaluate((k) => window.localStorage.getItem(k), TOUR_SEEN_KEY)).toBe('true');

    // A real reload must NOT re-show the tour (first-run persistence).
    await page.goto('/');
    await expect(page.getByTestId('app-title')).toHaveText('DQ Dental CAD');
    await expect(page.getByTestId('onboarding-tour')).toHaveCount(0);
  });

  test('keyboard shortcut: bare `?` fires help.shortcuts (global dispatcher → registry)', async () => {
    // Nothing focused (no editable target) so the bare-key chord is live.
    await expect(page.getByTestId('shortcuts-help')).toHaveCount(0);
    await page.keyboard.press('?');
    await expect(page.getByTestId('shortcuts-help')).toBeVisible({ timeout: 10_000 });
    // The overlay lists at least the shortcut rows (help.shortcuts + others).
    await expect(page.getByTestId('shortcuts-help-row-help.shortcuts')).toBeVisible();
    await page.getByTestId('shortcuts-help-close').click();
    await expect(page.getByTestId('shortcuts-help')).toHaveCount(0);
  });

  test('command palette: Cmd/Ctrl+K opens, filters the one registry, runs an action, closes', async () => {
    const palette = page.getByTestId('command-palette');
    await expect(palette).toHaveCount(0);

    // Open with the industry-standard chord (allowInEditable — works anywhere).
    await page.keyboard.press('ControlOrMeta+k');
    await expect(palette).toBeVisible({ timeout: 10_000 });

    // Filter: typing "shortcut" keeps help.shortcuts and drops case.save.
    await page.getByTestId('command-palette-input').fill('shortcut');
    await expect(page.getByTestId('command-palette-option-help.shortcuts')).toBeVisible();
    await expect(page.getByTestId('command-palette-option-case.save')).toHaveCount(0);

    // Escape closes it (a11y) — prove the close path first.
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);

    // Re-open, filter, and RUN the action by clicking its option → the shortcuts
    // help overlay opens (the action ran) and the palette closes.
    await page.keyboard.press('ControlOrMeta+k');
    await expect(palette).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('command-palette-input').fill('shortcut');
    await page.getByTestId('command-palette-option-help.shortcuts').click();
    await expect(palette).toHaveCount(0);
    await expect(page.getByTestId('shortcuts-help')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('shortcuts-help-close').click();
    await expect(page.getByTestId('shortcuts-help')).toHaveCount(0);
  });

  test('auth gate (ENABLED): token-less mutation is rejected 401; bootstrapped token is accepted', async () => {
    // A mutating POST WITHOUT a token → 401 auth-required (the gate composes over
    // every mutating method; ADR-020). Run same-origin (through the Vite proxy).
    const unauthed = await page.evaluate(async () => {
      const res = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'e2e-auth-probe' }),
      });
      return { status: res.status, body: (await res.json()) as { error?: string } };
    });
    expect(unauthed.status).toBe(401);
    expect(unauthed.body.error).toBe('auth-required');

    // The same-origin bootstrap yields the active token (proves the gate is
    // genuinely ENABLED — a non-empty token is returned).
    const token = await page.evaluate(async () => {
      const res = await fetch('/api/auth/bootstrap');
      return ((await res.json()) as { token?: string | null }).token ?? null;
    });
    expect(typeof token).toBe('string');
    expect((token as string).length).toBeGreaterThan(0);

    // The SAME POST WITH the bearer token → accepted (201). Nothing is left
    // depending on this probe case; it just proves the authed path works.
    const authed = await page.evaluate(async (t) => {
      const res = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
        body: JSON.stringify({ name: 'e2e-auth-probe' }),
      });
      return { status: res.status };
    }, token);
    expect(authed.status).toBe(201);
  });

  test('autosave → simulated crash → recovery restores the un-synced case state', async () => {
    // Create a case (all these mutations carry the token — main.tsx initAuth()).
    await page.getByTestId('open-case-picker-button').click();
    await expect(page.getByTestId('case-picker')).toBeVisible();
    await page.getByTestId('case-picker-new-case-name').fill(caseName);
    await page.getByTestId('case-picker-new-case-name').press('Enter');
    await expect(page.getByTestId('case-picker')).toBeHidden();
    await expect(page.getByTestId('active-case-name')).toHaveText(caseName);

    // Import the die (a scene node → status 'unsaved'), no rescale dialog.
    await page.getByTestId('import-file-input').setInputFiles(diePath);
    const row = page.getByTestId('import-file-row').filter({ hasText: 'phase8-prep-die.stl' });
    await expect(row.getByTestId('import-role-select')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('unit-confirm-keep-mm')).toHaveCount(0);
    await row.getByTestId('import-role-select').selectOption('prepDie');
    await expect(page.getByTestId('scene-tree-row')).toHaveCount(1);

    // SAVE — uploads the mesh (fileHash stamped) and clears the crash-safe
    // snapshot; the case is now fully server-synced.
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 30_000 });

    // The UN-SYNCED edit: create a restoration AFTER the save. It exists only in
    // the local (in-memory + crash-safe) state — the server never received it.
    await page.getByTestId('restoration-type-crown').click();
    await page.getByTestId(`fdi-tooth-${RECOVERY_TOOTH}`).click();
    await page.getByTestId('restoration-target-select').selectOption({ index: 1 });
    await expect(page.getByTestId('restoration-submit-button')).toBeEnabled();
    await page.getByTestId('restoration-submit-button').click();
    await expect(page.getByTestId(`restoration-chip-${RECOVERY_TOOTH}`)).toBeVisible();

    // Wait for the debounced (2 s) crash-safe snapshot to COMMIT: a marker with
    // cleanShutdown=false and the un-synced journal op count.
    await expect
      .poll(
        async () =>
          page.evaluate((k) => {
            const raw = window.localStorage.getItem(k);
            if (raw === null) return -1;
            const m = JSON.parse(raw) as { cleanShutdown: boolean; journalOperationCount: number };
            return m.cleanShutdown === false ? m.journalOperationCount : -1;
          }, MARKER_KEY),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    // SIMULATE A CRASH: rewrite the marker's owning sessionId to a foreign value.
    // This page's pagehide handler (markCleanShutdown) only marks clean when the
    // marker belongs to THIS session, so on the reload below it CANNOT flip
    // cleanShutdown → the exact unclean-shutdown condition a real crash leaves.
    const markerCaseName = await page.evaluate((k) => {
      const m = JSON.parse(window.localStorage.getItem(k)!) as { sessionId: string; caseName: string };
      m.sessionId = `e2e-crashed-session-${Math.random().toString(36).slice(2)}`;
      window.localStorage.setItem(k, JSON.stringify(m));
      return m.caseName;
    }, MARKER_KEY);
    expect(markerCaseName).toBe(caseName);

    // Reload — the previous session left un-synced work + no clean shutdown.
    await page.goto('/');
    await expect(page.getByTestId('app-title')).toHaveText('DQ Dental CAD');

    // The recovery prompt is offered (no silent auto-restore, no silent discard).
    const prompt = page.getByTestId('recovery-prompt');
    await expect(prompt).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('recovery-prompt-case-name')).toContainText(caseName);
    // It is a RECOVERABLE prompt, not a corrupt one.
    await expect(page.getByTestId('recovery-prompt-corrupt')).toHaveCount(0);

    // Restore → state-identical recovery of the un-synced work.
    await page.getByTestId('recovery-prompt-restore').click();
    // A clean restore (the die mesh reconstructs from the server by fileHash) —
    // NOT the SF2 "incomplete" surface.
    await expect(page.getByTestId('recovery-prompt-incomplete')).toHaveCount(0);
    await expect(prompt).toBeHidden({ timeout: 30_000 });

    // The restored case is state-identical: the active case name AND the
    // un-synced restoration chip (which the server never saw) both come back.
    await expect(page.getByTestId('active-case-name')).toHaveText(caseName, { timeout: 15_000 });
    await expect(page.getByTestId(`restoration-chip-${RECOVERY_TOOTH}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('scene-tree-row')).toHaveCount(1);
  });

  test('telemetry-free error bundle: local blob download, no egress, no PHI (case name absent)', async () => {
    // Raise the non-blocking error surface via a synthetic window error (the real
    // engine/errorCapture.ts window.onerror path).
    await page.evaluate(() => {
      window.dispatchEvent(
        new ErrorEvent('error', {
          error: new Error('E2E synthetic diagnostic error'),
          message: 'E2E synthetic diagnostic error',
        }),
      );
    });
    const surface = page.getByTestId('error-report-surface');
    await expect(surface).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('error-report-detail')).toContainText('E2E synthetic diagnostic error');

    // Download the diagnostic bundle → a LOCAL file from a blob: object URL (no
    // network egress: the file is produced client-side, not fetched).
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('error-report-download').click();
    const download = await downloadPromise;
    expect(download.url().startsWith('blob:')).toBe(true);

    const bundlePath = join(tmpDir, 'diagnostic-bundle.json');
    await download.saveAs(bundlePath);
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as {
      app?: { kernelVersion?: string };
      error?: { message?: string };
    };
    // The bundle carries the app/kernel versions + the error, but NO PHI: the
    // loaded case's NAME must never appear (allowlist-not-denylist posture).
    expect(bundle.app?.kernelVersion).toBe('0.26.0');
    expect(bundle.error?.message).toContain('E2E synthetic diagnostic error');
    expect(readFileSync(bundlePath, 'utf8')).not.toContain(caseName);

    await page.getByTestId('error-report-dismiss').click();
    await expect(surface).toHaveCount(0);
  });
});
