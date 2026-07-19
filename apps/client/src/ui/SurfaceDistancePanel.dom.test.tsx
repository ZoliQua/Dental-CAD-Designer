// apps/client/src/ui/SurfaceDistancePanel.dom.test.tsx
//
// Phase 2 Task 12: real-DOM `client-dom` project test (browser mode — see
// README.md in this directory). Targets the manual min/max range inputs'
// behavior, the exact gap a prior per-task review flagged (see
// .superpowers/sdd/progress.md's P1 Task 9 minor note): "SurfaceDistancePanel
// manual range inputs lack min>max validation (degenerate all-white
// colormap, graceful)" — this proves that documented "graceful degenerate"
// behavior end to end (real component, real store, real heatmapEngine) via
// an actual test rather than a code-review observation, WITHOUT silently
// turning an undocumented gap into an assumed pass: no clamping/validation
// exists, and this test says so explicitly rather than asserting one exists.
//
// The heatmap run itself goes through the REAL kernel-workers WorkerPool
// (browser Web Worker path — buildBvh + distanceHeatmap jobs, now
// affinity-routed — see engine/heatmap.ts/workers.ts) against two real
// (small, synthetic) meshes, same "no-mock philosophy" as the other
// client-dom tests in this directory — `heatmapEngine.setRange`'s no-op
// guard when no run has completed means the range-input interaction can
// only be exercised meaningfully after a REAL run populates its private
// `distances` field.
import { act } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { caseStore } from '../engine/caseStore';
import { heatmapEngine } from '../engine/heatmap';
// `MeshStats` re-exported from engine/repair.ts (not `@dqcad/kernel-workers`
// directly) — see RepairPanel.dom.test.tsx's identical import comment for
// why (the `ui` layer may not import `kernel-workers`, CLAUDE.md's
// lint-enforced layer rule). `IntakeReport` has no such re-export, so
// `registerMesh` below passes an untyped object literal for it instead.
import { type MeshStats } from '../engine/repair';
import { useHeatmapStore } from '../state/heatmapStore';
import { SurfaceDistancePanel } from './SurfaceDistancePanel';

const EMPTY_REPORT = { weldEpsilonMm: 1e-6, steps: [] };

const CUBE_STATS: MeshStats = {
  watertight: true,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  surfaceAreaMm2: 6,
  signedVolumeMm3: 1,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};

const CUBE_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];
const CUBE_TRIANGLES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 2, 1],
  [0, 3, 2],
  [4, 5, 6],
  [4, 6, 7],
  [0, 1, 5],
  [0, 5, 4],
  [1, 2, 6],
  [1, 6, 5],
  [2, 3, 7],
  [2, 7, 6],
  [0, 4, 7],
  [0, 7, 3],
];

function cubeIndices(): Uint32Array {
  return Uint32Array.from(CUBE_TRIANGLES.flat());
}

function cubePositions(offsetX = 0): Float64Array {
  const positions = new Float64Array(CUBE_CORNERS.flat());
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (positions[i] ?? 0) + offsetX;
  }
  return positions;
}

function registerMesh(contentHash: string, offsetX: number): void {
  caseStore.registerImportedMesh({
    contentHash,
    name: 'scan.stl',
    format: 'stl',
    positions: cubePositions(offsetX),
    indices: cubeIndices(),
    stats: CUBE_STATS,
    report: EMPTY_REPORT,
    operations: [],
  });
}

beforeEach(() => {
  caseStore.resetForTests();
  heatmapEngine.resetForTests();
});

afterEach(() => {
  cleanup();
  caseStore.resetForTests();
  heatmapEngine.resetForTests();
});

describe('SurfaceDistancePanel — manual range inputs (no min>max validation, documented graceful-degenerate behavior)', () => {
  it('accepts a manually-entered min > max without throwing, and stores it exactly as entered (no clamping/swap)', async () => {
    const user = userEvent.setup();
    // Two disjoint unit cubes (10 mm apart) — real, cheap geometry for a
    // real distanceHeatmap worker job.
    registerMesh('dist-a', 0);
    registerMesh('dist-b', 10);
    const nodeA = caseStore.addSceneNode('dist-a', 'situ');
    const nodeB = caseStore.addSceneNode('dist-b', 'antagonist');

    render(<SurfaceDistancePanel />);

    await user.selectOptions(screen.getByTestId('heatmap-mesh-a-select'), nodeA.id);
    await user.selectOptions(screen.getByTestId('heatmap-mesh-b-select'), nodeB.id);
    await user.click(screen.getByTestId('heatmap-run-button'));

    // Real buildBvh + distanceHeatmap worker jobs (browser Web Worker path)
    // — wait for the result stats table to actually appear.
    await waitFor(
      () => {
        expect(screen.getByTestId('heatmap-stats')).toBeTruthy();
      },
      { timeout: 10_000 },
    );

    const minInput = screen.getByLabelText('Min (µm)') as HTMLInputElement;
    const maxInput = screen.getByLabelText('Max (µm)') as HTMLInputElement;

    await user.clear(minInput);
    await user.type(minInput, '500');
    await user.clear(maxInput);
    await user.type(maxInput, '10');
    expect(minInput.value).toBe('500');
    expect(maxInput.value).toBe('10');

    await user.click(screen.getByRole('button', { name: 'Apply range' }));

    // No validation exists (documented gap, not a bug being asserted away):
    // the store ends up with min > max EXACTLY as typed, in mm.
    await waitFor(() => {
      const range = useHeatmapStore.getState().range;
      expect(range).not.toBeNull();
      expect(range!.min).toBeCloseTo(0.5, 9); // 500 µm
      expect(range!.max).toBeCloseTo(0.01, 9); // 10 µm
    });
    expect(useHeatmapStore.getState().autoRange).toBe(false);

    // Graceful, not a crash: the legend still renders (degenerate
    // min>max gradient/ticks, per the documented note above), and the
    // "Auto range" button is enabled again (re-computable escape hatch).
    expect(screen.getByTestId('heatmap-legend')).toBeTruthy();
    const autoButton = screen.getByRole('button', { name: 'Auto range' }) as HTMLButtonElement;
    expect(autoButton.disabled).toBe(false);

    await act(async () => {
      await user.click(autoButton);
    });
    await waitFor(() => {
      expect(useHeatmapStore.getState().autoRange).toBe(true);
    });
  });
});
