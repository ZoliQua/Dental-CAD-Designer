// curvature.test.ts — exercised through the REAL WorkerPool (Node
// worker_threads path), same rationale as heatmap.test.ts: this module is
// orchestration (worker round trip, store publishing), not geometry — the
// geometry itself (computeCurvature correctness) is already covered by
// packages/kernel/src/curvature/*.test.ts and
// packages/kernel-workers/src/curvatureJob.test.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import type { IntakeReport, MeshStats } from '@dqcad/kernel-workers';
import { useCurvatureStore } from '../state/curvatureStore';
import { caseStore } from './caseStore';
import { curvatureEngine } from './curvature';

const EMPTY_REPORT: IntakeReport = { weldEpsilonMm: 1e-6, steps: [] };

const OCTAHEDRON_STATS: MeshStats = {
  watertight: true,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [-2, -2, -2], max: [2, 2, 2] },
  surfaceAreaMm2: 100,
  signedVolumeMm3: 10,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};

/** Unit-radius octahedron — a small, well-known closed convex manifold
 * (every vertex has strictly positive H and K) — same shape family as
 * packages/kernel-workers/src/curvatureJob.test.ts's own fixture. */
function octahedronMesh(): { positions: Float64Array; indices: Uint32Array } {
  const positions = new Float64Array([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]);
  const indices = Uint32Array.from(
    [
      [0, 2, 4],
      [2, 1, 4],
      [1, 3, 4],
      [3, 0, 4],
      [2, 0, 5],
      [1, 2, 5],
      [3, 1, 5],
      [0, 3, 5],
    ].flat(),
  );
  return { positions, indices };
}

function registerOctahedronNode(contentHash: string): string {
  const { positions, indices } = octahedronMesh();
  caseStore.registerImportedMesh({
    contentHash,
    name: `${contentHash}.stl`,
    format: 'stl',
    positions,
    indices,
    stats: OCTAHEDRON_STATS,
    report: EMPTY_REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode(contentHash, 'situ');
  return node.id;
}

beforeEach(() => {
  caseStore.resetForTests();
  curvatureEngine.resetForTests();
});

describe('curvatureEngine.run', () => {
  it('colors an octahedron by mean curvature H (every vertex convex -> positive)', async () => {
    const nodeId = registerOctahedronNode('octa-h');
    await curvatureEngine.run(nodeId, 'H');

    const state = useCurvatureStore.getState();
    expect(state.status).toBe('done');
    expect(state.error).toBeNull();
    expect(state.field).toBe('H');
    expect(state.stats).not.toBeNull();
    expect(state.stats!.min).toBeGreaterThan(0);
    expect(state.stats!.max).toBeGreaterThan(0);
    expect(state.range).not.toBeNull();
    expect(state.visible).toBe(true); // completing a run shows the overlay immediately
  });

  it('colors by Gaussian curvature K when requested', async () => {
    const nodeId = registerOctahedronNode('octa-k');
    await curvatureEngine.run(nodeId, 'K');

    const state = useCurvatureStore.getState();
    expect(state.status).toBe('done');
    expect(state.field).toBe('K');
    expect(state.stats!.min).toBeGreaterThan(0); // every octahedron corner is convex
  });

  it('is a no-op when the SceneNode id is stale', async () => {
    await curvatureEngine.run('not-a-real-node', 'H');
    expect(useCurvatureStore.getState().status).toBe('idle');
  });

  it('getActiveOverlay reflects the visible toggle', async () => {
    const nodeId = registerOctahedronNode('octa-overlay');
    await curvatureEngine.run(nodeId, 'H');

    expect(curvatureEngine.getActiveOverlay()).not.toBeNull();
    expect(curvatureEngine.getActiveOverlay()!.nodeId).toBe(nodeId);
    expect(curvatureEngine.getActiveOverlay()!.colors.length).toBe(6 * 3); // 6 vertices x rgb

    curvatureEngine.setVisible(false);
    expect(curvatureEngine.getActiveOverlay()).toBeNull();

    curvatureEngine.setVisible(true);
    expect(curvatureEngine.getActiveOverlay()).not.toBeNull();
  });

  it('setRange overrides the display range and getActiveOverlay recolors accordingly', async () => {
    const nodeId = registerOctahedronNode('octa-range');
    await curvatureEngine.run(nodeId, 'H');

    const autoColors = curvatureEngine.getActiveOverlay()!.colors.slice();
    curvatureEngine.setRange({ min: -10, max: 10 }); // a much wider range -> different colors
    const manualColors = curvatureEngine.getActiveOverlay()!.colors;
    expect(useCurvatureStore.getState().autoRange).toBe(false);
    expect(useCurvatureStore.getState().range).toEqual({ min: -10, max: 10 });
    expect(Array.from(manualColors)).not.toEqual(Array.from(autoColors));

    curvatureEngine.setRange(null); // revert to auto
    expect(useCurvatureStore.getState().autoRange).toBe(true);
  });

  it('clear resets the store and drops the active overlay', async () => {
    const nodeId = registerOctahedronNode('octa-clear');
    await curvatureEngine.run(nodeId, 'H');
    expect(curvatureEngine.getActiveOverlay()).not.toBeNull();

    curvatureEngine.clear();
    expect(curvatureEngine.getActiveOverlay()).toBeNull();
    expect(useCurvatureStore.getState().status).toBe('idle');
    expect(useCurvatureStore.getState().stats).toBeNull();
  });
});
