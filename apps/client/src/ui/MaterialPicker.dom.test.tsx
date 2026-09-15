// apps/client/src/ui/MaterialPicker.dom.test.tsx
//
// Feature #3 (live multi-material picker) — browser-lane critical path
// (client-dom project; see ui/README.md). Real caseStore/state, no mocking:
// a real tiny SceneNode stands in for "a case is open", exactly like
// RestorationWizard.dom.test.tsx.
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n'; // side-effect: initializes i18next synchronously
import type { QcReport, Restoration } from '@dqcad/shared-types';
import { caseStore } from '../engine/caseStore';
// The `ui` layer (tests included) may not import `@dqcad/clinical-profiles`
// directly (the layer rule, lint-enforced) — the registry reaches ui only
// through the engine seam, exactly as the picker itself consumes it.
import { KNOWN_PROFILES } from '../engine/materialProfile';
import { type MeshStats } from '../engine/repair';
import { createRestoration } from '../engine/restorations';
import { useCaseStore } from '../state/caseStore';
import { MaterialPicker } from './MaterialPicker';

const ZIRCONIA = KNOWN_PROFILES[0]!;
const EMAX = KNOWN_PROFILES[1]!;

const EMPTY_REPORT = { weldEpsilonMm: 1e-6, steps: [] };

const TRIANGLE_STATS: MeshStats = {
  watertight: false,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [0, 0, 0], max: [1, 1, 0] },
  surfaceAreaMm2: 0.5,
  signedVolumeMm3: null,
  degenerateCount: 0,
  boundaryEdgeCount: 3,
};

/** Registers a tiny prep scan + SceneNode — makes `document.scene.length > 0`,
 * i.e. "a case is open" (the picker's enabled condition). */
function openACase(): void {
  caseStore.registerImportedMesh({
    contentHash: 'material-scan',
    name: 'prep-die.stl',
    format: 'stl',
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    stats: TRIANGLE_STATS,
    report: EMPTY_REPORT,
    operations: [],
  });
  caseStore.addSceneNode('material-scan', 'prepDie');
}

function passingQc(journalHash: string): QcReport {
  return {
    gates: [
      { gate: 'watertight', passed: true, acknowledged: false, value: null, threshold: null, unit: null, message: 'ok' },
    ],
    passed: true,
    kernelVersion: '0.0.0',
    profileVersion: ZIRCONIA.version,
    journalHash,
  };
}

function addRestorationWithQc(): Restoration {
  // createRestoration already commits the restoration (with qc: null); give it a
  // built shell + a passing QC report via updateRestoration (one restoration,
  // index 0) so the invalidation is observable.
  const restoration = createRestoration({ type: 'crown', teeth: [11], targetNodeId: null });
  const withStagesQc: Restoration = { ...restoration, stages: { finalMesh: 'mesh-1' }, qc: passingQc('mesh-1') };
  return caseStore.updateRestoration(withStagesQc, {
    id: 'op-qc',
    name: 'crown-qc',
    params: {},
    inputHashes: [],
    outputHashes: [],
    kernelVersion: 'test',
    timestamp: new Date().toISOString(),
  });
}

beforeEach(() => {
  caseStore.resetForTests();
});

afterEach(() => {
  cleanup();
  caseStore.resetForTests();
});

describe('MaterialPicker — critical path', () => {
  it('is DISABLED when no case is open (empty scene)', () => {
    render(<MaterialPicker />);
    const select = screen.getByTestId('material-picker-select') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    // Both shipped materials are offered, driven by the registry (not hardcoded).
    expect(screen.getByRole('option', { name: ZIRCONIA.label })).toBeTruthy();
    expect(screen.getByRole('option', { name: EMAX.label })).toBeTruthy();
  });

  it('reflects the PERSISTED material on open (e.max selected shows e.max)', () => {
    openACase();
    caseStore.setMaterialProfile(EMAX.id);
    render(<MaterialPicker />);
    const select = screen.getByTestId('material-picker-select') as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(select.value).toBe(EMAX.id);
  });

  it('reflects the effective zirconia default for a fresh (unset-material) case', () => {
    openACase();
    render(<MaterialPicker />);
    const select = screen.getByTestId('material-picker-select') as HTMLSelectElement;
    // Empty settings -> the select shows zirconia (what QC/export actually use).
    expect(select.value).toBe(ZIRCONIA.id);
  });

  it('selecting e.max persists the material AND marks existing QC stale (invalidated)', async () => {
    const user = userEvent.setup();
    openACase();
    addRestorationWithQc();
    expect(useCaseStore.getState().document.restorations[0]!.qc).not.toBeNull();

    render(<MaterialPicker />);
    await user.selectOptions(
      screen.getByTestId('material-picker-select'),
      EMAX.id,
    );

    const doc = useCaseStore.getState().document;
    // Persisted onto the case settings (from the registry — id + version).
    expect(doc.settings.materialProfileId).toBe(EMAX.id);
    expect(doc.settings.profileVersion).toBe(EMAX.version);
    // The prior QC report is no longer authoritative -> invalidated (visible in
    // the design panel as "run QC").
    expect(doc.restorations[0]!.qc).toBeNull();
  });

  it('selecting back to zirconia persists zirconia', async () => {
    const user = userEvent.setup();
    openACase();
    caseStore.setMaterialProfile(EMAX.id);

    render(<MaterialPicker />);
    await user.selectOptions(
      screen.getByTestId('material-picker-select'),
      ZIRCONIA.id,
    );
    expect(useCaseStore.getState().document.settings.materialProfileId).toBe(ZIRCONIA.id);
  });
});
