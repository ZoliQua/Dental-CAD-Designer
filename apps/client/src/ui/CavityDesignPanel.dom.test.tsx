// apps/client/src/ui/CavityDesignPanel.dom.test.tsx
//
// Phase 5 Task 8 — browser-lane (`client-dom`, real Chromium + real
// kernel-workers Web Worker pool) CRITICAL PATH for the inlay design workflow.
// Drives the full cavity pipeline (outline → fit → patch → contacts → shell →
// QC) through the actual UI on the CLIENT-ported analytic MOD cavity fixture
// (engine/cavityGeometry.ts — verified accepted by the real kernel cavity ops),
// asserting the store + journal update at each stage, that the QC gate table
// renders WITH the seam-dihedral row, and that a downstream re-run invalidates a
// prior QC report (the stale-QC guard — a stale report must NEVER keep
// displaying). Same no-mock philosophy + fixture-per-file convention as
// ui/CrownDesignPanel.dom.test.tsx.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { caseStore } from '../engine/caseStore';
import { cavityDesignEngine } from '../engine/cavityDesign';
import { buildModCavity } from '../engine/cavityGeometry';
import { createRestoration } from '../engine/restorations';
import { type MeshStats } from '../engine/repair';
import { CavityDesignPanel } from './CavityDesignPanel';

const STATS: MeshStats = {
  watertight: true,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [-5, -4.5, 0], max: [5, 4.5, 7.5] },
  surfaceAreaMm2: 1,
  signedVolumeMm3: 500,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};
const REPORT = { weldEpsilonMm: 1e-6, steps: [] };

function setupInlayCase(): string {
  const fx = buildModCavity();
  caseStore.registerImportedMesh({
    contentHash: 'cavity-tooth',
    name: 'tooth.stl',
    format: 'stl',
    positions: fx.mesh.positions,
    indices: fx.mesh.indices,
    stats: STATS,
    report: REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode('cavity-tooth', 'prepDie');
  const restoration = createRestoration({ type: 'inlay', teeth: [16], targetNodeId: node.id });
  // The cavity outline IS the restoration's confirmed margin line (its
  // resampledPoints) — the "preparációs határvonal" of the cavity.
  caseStore.updateRestoration(
    { ...restoration, marginLines: { 16: { anchors: [], closed: true, resampledPoints: fx.cavityOutline } } },
    { id: 'op-outline', name: 'margin-edit', params: { tooth: 16 }, inputHashes: [], outputHashes: [], kernelVersion: '0.0.0-test', timestamp: new Date().toISOString() },
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
  cavityDesignEngine.resetForTests();
});
afterEach(() => {
  cleanup();
  cavityDesignEngine.resetForTests();
  caseStore.resetForTests();
});

describe('CavityDesignPanel — browser-lane critical path (real WorkerPool, MOD cavity fixture)', () => {
  it('drives outline → fit → patch → contacts → shell → QC through the UI, journaling each stage and rendering the QcReport with the seam-dihedral row', async () => {
    const user = userEvent.setup();
    const id = setupInlayCase();

    render(<CavityDesignPanel />);
    await user.selectOptions(screen.getByTestId('cavity-restoration-select'), id);
    await user.click(screen.getByTestId('cavity-start-button'));

    // Outline is already confirmed (the restoration carries the cavity outline).
    expect(screen.getByTestId('cavity-stage-outline').getAttribute('data-complete')).toBe('true');

    // Stage: fit surface (coarse pitch for browser-lane speed).
    fireEvent.change(screen.getByTestId('cavity-fit-pitch'), { target: { value: '150' } });
    await user.click(screen.getByTestId('cavity-fit-run'));
    await waitFor(() => expect(screen.getByTestId('cavity-fit-readout')).toBeTruthy(), { timeout: 60_000 });
    expect(restoration(id).stages.fitSurface).toBeTypeOf('string');
    expect(historyNames()).toContain('inlay-fit-surface');

    // Stage: occlusal patch (seam-dihedral readout).
    await user.click(screen.getByTestId('cavity-patch-run'));
    await waitFor(() => expect(screen.getByTestId('cavity-patch-seam')).toBeTruthy(), { timeout: 60_000 });
    expect(restoration(id).stages.occlusalPatch).toBeTypeOf('string');
    expect(historyNames()).toContain('inlay-occlusal-patch');
    expect(screen.getByTestId('cavity-patch-seam').textContent).toMatch(/°/);

    // Stage: proximal box contacts.
    await user.click(screen.getByTestId('cavity-contacts-run'));
    await waitFor(() => expect(screen.getByTestId('cavity-contacts-table')).toBeTruthy(), { timeout: 60_000 });
    expect(restoration(id).stages.proximalContacts).toBeTypeOf('string');
    expect(historyNames()).toContain('inlay-proximal-contacts');

    // Stage: shell (must be watertight to proceed — the honest gate).
    await user.click(screen.getByTestId('cavity-shell-construct'));
    await waitFor(
      () => {
        const readout = screen.queryByTestId('cavity-shell-readout');
        const error = screen.queryByTestId('cavity-error');
        expect(readout || error).toBeTruthy();
      },
      { timeout: 60_000 },
    );
    expect(screen.queryByTestId('cavity-error')).toBeNull();
    expect(screen.getByTestId('cavity-shell-readout').textContent).toContain('✓');
    expect(restoration(id).stages.finalMesh).toBeTypeOf('string');
    expect(historyNames()).toContain('inlay-shell');

    // Stage: QC — the inlay gate table renders WITH the seam-dihedral row.
    await user.click(screen.getByTestId('cavity-qc-run'));
    await waitFor(() => expect(screen.getByTestId('cavity-qc-table')).toBeTruthy(), { timeout: 60_000 });
    expect(restoration(id).qc).not.toBeNull();
    expect(historyNames()).toContain('inlay-qc');
    expect(screen.getByTestId('cavity-qc-gate-seamDihedral')).toBeTruthy();
    expect(screen.getByTestId('cavity-qc-gate-watertight')).toBeTruthy();
    expect(screen.getByTestId('cavity-qc-gate-minWallThickness')).toBeTruthy();

    // Stale-QC guard: a downstream re-run (re-build the fit surface) invalidates
    // the report via the full cascade — the panel must NOT keep showing the
    // pass/fail banner. Because re-running fit clears the shell too, QC is
    // re-BLOCKED (the honest state: a report can never outlive its geometry).
    fireEvent.change(screen.getByTestId('cavity-fit-pitch'), { target: { value: '160' } });
    await user.click(screen.getByTestId('cavity-fit-run'));
    await waitFor(() => expect(screen.getByTestId('cavity-qc-blocked')).toBeTruthy(), { timeout: 60_000 });
    // The prior QC report is gone — no passed/failed/stale banner survives.
    expect(screen.queryByTestId('cavity-qc-passed')).toBeNull();
    expect(screen.queryByTestId('cavity-qc-failed')).toBeNull();
    expect(screen.queryByTestId('cavity-qc-stale')).toBeNull();
    expect(screen.queryByTestId('cavity-qc-table')).toBeNull();
    expect(restoration(id).qc).toBeNull();
    // The invalidation cascade also cleared the downstream stage hashes.
    expect(restoration(id).stages.occlusalPatch).toBeUndefined();
    expect(restoration(id).stages.finalMesh).toBeUndefined();
  }, 240_000);
});
