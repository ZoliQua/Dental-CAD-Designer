// apps/client/src/ui/CrownDesignPanel.dom.test.tsx
//
// Phase 4 Task 10 — browser-lane (`client-dom`, real Chromium + real
// kernel-workers Web Worker pool) CRITICAL PATH for the crown-design
// workflow. Drives the SIX pipeline stages through the actual UI on a SMALL
// SYNTHETIC CLEAN fixture (a cone-frustum prep die — NOT the real
// arch-case-01 tooth-11, which is unbuildable at the shell stage per the
// Task 9 finding), asserting the store + journal update at each stage and
// that the final QcReport renders. Same no-mock philosophy + fixture-per-file
// convention as ui/AxisPanel.dom.test.tsx.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { caseStore } from '../engine/caseStore';
import { crownDesignEngine } from '../engine/crownDesign';
import { buildFrustum, boxMesh, marginCircleVecs } from '../engine/crownGeometry';
import { createRestoration } from '../engine/restorations';
import { type MeshStats } from '../engine/repair';
import { useCrownStore } from '../state/crownStore';
import { CrownDesignPanel } from './CrownDesignPanel';

const STATS: MeshStats = {
  watertight: true,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [-1.2, -1.2, 0.5], max: [1.2, 1.2, 2] },
  surfaceAreaMm2: 1,
  signedVolumeMm3: 1,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};
const REPORT = { weldEpsilonMm: 1e-6, steps: [] };

const MARGIN_R = 1.2;
const MARGIN_Z = 0.5;

function setupCrownCase(): string {
  // Closed cone-frustum prep die (margin ring wider than the occlusal) — the
  // frustum family that reliably stitches into a watertight shell.
  const die = buildFrustum(MARGIN_R, 0.8, MARGIN_Z, 2.0, 96, true, true);
  caseStore.registerImportedMesh({
    contentHash: 'crown-die',
    name: 'die.stl',
    format: 'stl',
    positions: die.positions,
    indices: die.indices,
    stats: STATS,
    report: REPORT,
    operations: [],
  });
  const dieNode = caseStore.addSceneNode('crown-die', 'prepDie');

  // A synthetic antagonist just above the crown apex (occlusal contact).
  const antag = boxMesh([-1, -1, 3.0], [1, 1, 3.6]);
  caseStore.registerImportedMesh({
    contentHash: 'crown-antag',
    name: 'antag.stl',
    format: 'stl',
    positions: antag.positions,
    indices: antag.indices,
    stats: STATS,
    report: REPORT,
    operations: [],
  });
  caseStore.addSceneNode('crown-antag', 'antagonist');

  const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: dieNode.id });
  caseStore.updateRestoration(
    { ...restoration, marginLines: { 11: { anchors: [], closed: true, resampledPoints: marginCircleVecs(0, 0, MARGIN_R, MARGIN_Z, 240) } } },
    { id: 'op-margin', name: 'margin-edit', params: { tooth: 11 }, inputHashes: [], outputHashes: [], kernelVersion: '0.0.0-test', timestamp: new Date().toISOString() },
  );
  return restoration.id;
}

function historyNames(): string[] {
  return caseStore.getDocument().history.map((o) => o.name);
}
function restoration(id: string) {
  return caseStore.getDocument().restorations.find((r) => r.id === id)!;
}

beforeEach(() => {
  caseStore.resetForTests();
  crownDesignEngine.resetForTests();
});
afterEach(() => {
  cleanup();
  crownDesignEngine.resetForTests();
  caseStore.resetForTests();
});

describe('CrownDesignPanel — browser-lane critical path (real WorkerPool, synthetic frustum crown)', () => {
  it('drives inner → anatomy → morph → shell → QC through the UI, journaling each stage and rendering the QcReport', async () => {
    const user = userEvent.setup();
    const id = setupCrownCase();

    render(<CrownDesignPanel />);
    await user.selectOptions(screen.getByTestId('crown-restoration-select'), id);
    await user.click(screen.getByTestId('crown-start-button'));

    // Stage 1 — inner surface (coarse pitch for browser-lane speed).
    fireEvent.change(screen.getByTestId('crown-inner-pitch'), { target: { value: '100' } });
    await user.click(screen.getByTestId('crown-inner-run'));
    await waitFor(() => expect(screen.getByTestId('crown-inner-readout')).toBeTruthy(), { timeout: 40_000 });
    expect(restoration(id).stages.innerSurface).toBeTypeOf('string');
    expect(historyNames()).toContain('crown-inner-surface');

    // Stage 2 — anatomy placement (auto).
    await user.click(screen.getByTestId('crown-anatomy-autoplace'));
    await waitFor(() => expect(screen.getByTestId('crown-anatomy-readout')).toBeTruthy(), { timeout: 30_000 });
    expect(restoration(id).stages.anatomyPlacement).toBeTypeOf('string');
    expect(historyNames()).toContain('crown-anatomy');

    // Stage 3 — morph.
    await user.click(screen.getByTestId('crown-morph-run'));
    await waitFor(() => expect(screen.getByTestId('crown-morph-readout')).toBeTruthy(), { timeout: 30_000 });
    expect(restoration(id).stages.morphState).toBeTypeOf('string');
    expect(historyNames()).toContain('crown-morph');

    // Stage 4 — shell (must be watertight to proceed — the honest gate).
    await user.click(screen.getByTestId('crown-shell-construct'));
    await waitFor(
      () => {
        const readout = screen.queryByTestId('crown-shell-readout');
        const error = screen.queryByTestId('crown-error');
        expect(readout || error).toBeTruthy();
      },
      { timeout: 40_000 },
    );
    // On the CLEAN synthetic fixture the shell must succeed.
    expect(screen.queryByTestId('crown-error')).toBeNull();
    expect(screen.getByTestId('crown-shell-readout').textContent).toContain('✓');
    expect(restoration(id).stages.finalMesh).toBeTypeOf('string');
    expect(historyNames()).toContain('crown-shell');

    // Stage 6 — QC (freeform stage 5 is optional; skip straight to QC).
    await user.click(screen.getByTestId('crown-qc-run'));
    await waitFor(() => expect(screen.getByTestId('crown-qc-table')).toBeTruthy(), { timeout: 40_000 });
    expect(restoration(id).qc).not.toBeNull();
    expect(historyNames()).toContain('crown-qc');
    // The QcReport renders per-gate rows.
    expect(screen.getByTestId('crown-qc-gate-watertight')).toBeTruthy();

    // CRITICAL fix: a downstream edit (freeform sculpt) after QC invalidates
    // the report — the panel must NOT keep showing the old pass/fail banner.
    await user.click(screen.getByTestId('crown-freeform-apply'));
    await waitFor(() => expect(screen.getByTestId('crown-qc-notrun')).toBeTruthy(), { timeout: 40_000 });
    expect(screen.queryByTestId('crown-qc-passed')).toBeNull();
    expect(screen.queryByTestId('crown-qc-failed')).toBeNull();
    expect(screen.queryByTestId('crown-qc-stale')).toBeNull();
    expect(restoration(id).qc).toBeNull();
  }, 180_000);

  it('contact-strength slider re-runs the morph (resolveMorph) and updates the store', async () => {
    const user = userEvent.setup();
    const id = setupCrownCase();

    render(<CrownDesignPanel />);
    await user.selectOptions(screen.getByTestId('crown-restoration-select'), id);
    await user.click(screen.getByTestId('crown-start-button'));

    fireEvent.change(screen.getByTestId('crown-inner-pitch'), { target: { value: '120' } });
    await user.click(screen.getByTestId('crown-inner-run'));
    await waitFor(() => expect(screen.getByTestId('crown-inner-readout')).toBeTruthy(), { timeout: 40_000 });
    await user.click(screen.getByTestId('crown-anatomy-autoplace'));
    await waitFor(() => expect(screen.getByTestId('crown-anatomy-readout')).toBeTruthy(), { timeout: 30_000 });
    await user.click(screen.getByTestId('crown-morph-run'));
    await waitFor(() => expect(screen.getByTestId('crown-morph-readout')).toBeTruthy(), { timeout: 30_000 });

    const beforeContacts = useCrownStore.getState().morph?.contacts ?? [];
    const antStrengthBefore = beforeContacts.find((c) => c.kind === 'antagonist')?.strength ?? 1;

    // Drag the antagonist strength down — fires a live resolveMorph re-solve.
    fireEvent.change(screen.getByTestId('crown-morph-antagonist'), { target: { value: '0.3' } });

    await waitFor(
      () => {
        const contacts = useCrownStore.getState().morph?.contacts ?? [];
        const ant = contacts.find((c) => c.kind === 'antagonist');
        expect(ant?.strength).toBeLessThan(antStrengthBefore);
      },
      { timeout: 30_000 },
    );
    // No journal op for a live preview (the initial morph is the only crown-morph op so far).
    expect(historyNames().filter((n) => n === 'crown-morph').length).toBe(1);
  }, 180_000);
});
