// apps/client/src/ui/RestorationWizard.dom.test.tsx
//
// Phase 3 Task 2's browser-lane critical-path test (client-dom project — see
// ui/README.md for the lane's conventions). Real caseStore/state, no
// mocking: a real SceneNode (a fabricated but real, tiny mesh) is registered
// as the target scan, exactly like RepairPanel.dom.test.tsx's fixtures.
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n'; // side-effect: initializes i18next synchronously
import { caseStore } from '../engine/caseStore';
// `MeshStats` re-exported from engine/repair.ts (not `@dqcad/kernel-workers`
// directly) — the `ui` layer may not import `kernel-workers` (CLAUDE.md's
// layer rule, lint-enforced) — same convention RepairPanel.dom.test.tsx
// already documents. No such re-export exists for `IntakeReport`, so
// `registerPrepScan` below passes `report` as a plain untyped object literal
// instead (TypeScript still structurally checks it against
// `caseStore.registerImportedMesh`'s parameter type).
import { type MeshStats } from '../engine/repair';
import { RestorationWizard } from './RestorationWizard';

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

function registerPrepScan(contentHash: string): ReturnType<typeof caseStore.addSceneNode> {
  caseStore.registerImportedMesh({
    contentHash,
    name: 'prep-die.stl',
    format: 'stl',
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    stats: TRIANGLE_STATS,
    report: EMPTY_REPORT,
    operations: [],
  });
  return caseStore.addSceneNode(contentHash, 'prepDie');
}

beforeEach(() => {
  caseStore.resetForTests();
});

afterEach(() => {
  // Real-browser lane has no implicit auto-cleanup — see ui/README.md.
  cleanup();
  caseStore.resetForTests();
});

describe('RestorationWizard — critical path', () => {
  it('creates a crown on tooth 11: a chip for 11 appears in the restoration list', async () => {
    const user = userEvent.setup();
    const node = registerPrepScan('wizard-crown-scan');

    render(<RestorationWizard />);

    expect(screen.getByTestId('restoration-type-crown').getAttribute('aria-pressed')).toBe('true');

    await user.click(screen.getByTestId('fdi-tooth-11'));
    await user.selectOptions(screen.getByTestId('restoration-target-select'), node.id);
    await user.click(screen.getByTestId('restoration-submit-button'));

    const chip = await screen.findByTestId('restoration-chip-11');
    expect(chip.textContent).toBe('11');
    expect(chip.className).not.toContain('restoration-chip--pontic');
    expect(screen.queryByTestId('restoration-empty')).toBeNull();
  });

  it('creates a bridge 12-11-21-22 with 12/22 marked pontic (2 clicks) and 11/21 abutment (1 click)', async () => {
    const user = userEvent.setup();
    const node = registerPrepScan('wizard-bridge-scan');

    render(<RestorationWizard />);

    await user.click(screen.getByTestId('restoration-type-bridge'));
    expect(screen.getByTestId('restoration-type-bridge').getAttribute('aria-pressed')).toBe('true');

    // Abutments (1 click each: none -> abutment).
    await user.click(screen.getByTestId('fdi-tooth-11'));
    await user.click(screen.getByTestId('fdi-tooth-21'));
    // Pontics (2 clicks each: none -> abutment -> pontic).
    await user.click(screen.getByTestId('fdi-tooth-12'));
    await user.click(screen.getByTestId('fdi-tooth-12'));
    await user.click(screen.getByTestId('fdi-tooth-22'));
    await user.click(screen.getByTestId('fdi-tooth-22'));

    // Contiguous span (12,11,21,22) — no contiguity warning.
    expect(screen.queryByTestId('bridge-contiguity-warning')).toBeNull();

    await user.selectOptions(screen.getByTestId('restoration-target-select'), node.id);
    expect((screen.getByTestId('restoration-submit-button') as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByTestId('restoration-submit-button'));

    const abutmentChip = await screen.findByTestId('restoration-chip-11');
    const ponticChip = screen.getByTestId('restoration-chip-12');
    expect(abutmentChip.className).not.toContain('restoration-chip--pontic');
    expect(ponticChip.className).toContain('restoration-chip--pontic');
    expect(screen.getByTestId('restoration-chip-21').className).not.toContain('restoration-chip--pontic');
    expect(screen.getByTestId('restoration-chip-22').className).toContain('restoration-chip--pontic');
  });

  it('shows a non-blocking contiguity warning and disables submit when a bridge skips a tooth', async () => {
    const user = userEvent.setup();
    const node = registerPrepScan('wizard-gap-scan');

    render(<RestorationWizard />);

    await user.click(screen.getByTestId('restoration-type-bridge'));
    // 11 and 22, skipping 21/12 in between (see fdiChart.ts's chart order).
    await user.click(screen.getByTestId('fdi-tooth-11'));
    await user.click(screen.getByTestId('fdi-tooth-22'));
    await user.selectOptions(screen.getByTestId('restoration-target-select'), node.id);

    const warning = await screen.findByTestId('bridge-contiguity-warning');
    expect(warning.textContent).toBeTruthy();
    expect((screen.getByTestId('restoration-submit-button') as HTMLButtonElement).disabled).toBe(true);
  });
});
