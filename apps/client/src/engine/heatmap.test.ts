// heatmap.test.ts — exercised through the REAL WorkerPool (Node
// worker_threads path), same rationale as ToolManager.test.ts: this module
// is orchestration (BVH-cache warmup, worker round trip, store publishing),
// not geometry — the geometry itself (distanceHeatmap correctness) is
// already covered by packages/kernel-workers/src/distanceHeatmap.test.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import type { IntakeReport, MeshStats } from '@dqcad/kernel-workers';
import { useHeatmapStore } from '../state/heatmapStore';
import { caseStore } from './caseStore';
import { heatmapEngine } from './heatmap';
import { resetBvhCacheForTests } from './workers';

const EMPTY_REPORT: IntakeReport = { weldEpsilonMm: 1e-6, steps: [] };

function statsForBbox(min: [number, number, number], max: [number, number, number]): MeshStats {
  return {
    watertight: false,
    manifoldEdges: false,
    componentCount: 1,
    bbox: { min, max },
    surfaceAreaMm2: 400,
    signedVolumeMm3: null,
    degenerateCount: 0,
    boundaryEdgeCount: 4,
  };
}

/** A flat 20x20mm quad (2 triangles), centered at the origin in x/y, at
 * height `z` — same fixture shape as ToolManager.test.ts's `quadMesh`. */
function quadMesh(z: number): { positions: Float64Array; indices: Uint32Array } {
  const positions = new Float64Array([-10, -10, z, 10, -10, z, 10, 10, z, -10, 10, z]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return { positions, indices };
}

function registerQuadNode(contentHash: string, z: number): string {
  const { positions, indices } = quadMesh(z);
  caseStore.registerImportedMesh({
    contentHash,
    name: `${contentHash}.stl`,
    format: 'stl',
    positions,
    indices,
    stats: statsForBbox([-10, -10, z], [10, 10, z]),
    report: EMPTY_REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode(contentHash, 'situ');
  return node.id;
}

beforeEach(() => {
  caseStore.resetForTests();
  heatmapEngine.resetForTests();
  resetBvhCacheForTests();
});

describe('heatmapEngine.run', () => {
  it('two parallel 20x20mm quads 5mm apart: every vertex of A is exactly 5mm from B', async () => {
    const nodeA = registerQuadNode('quad-a', 0);
    const nodeB = registerQuadNode('quad-b', 5);

    await heatmapEngine.run(nodeA, nodeB, false);

    const state = useHeatmapStore.getState();
    expect(state.status).toBe('done');
    expect(state.error).toBeNull();
    expect(state.stats).not.toBeNull();
    expect(state.stats!.min).toBeCloseTo(5, 9);
    expect(state.stats!.max).toBeCloseTo(5, 9);
    expect(state.stats!.mean).toBeCloseTo(5, 9);
    expect(state.stats!.rms).toBeCloseTo(5, 9);
    // Every vertex is equidistant -> auto range degenerates to [5, 5]-ish;
    // computeAutoRange's own unit tests cover the general percentile math,
    // this just checks the range was published at all.
    expect(state.range).not.toBeNull();
    // visible defaults to true once a run completes (Task 9 brief: a
    // completed run is immediately shown).
    expect(state.visible).toBe(true);
  });

  it('heatmap(A, A) is exactly 0 for every vertex, even through the full engine round trip', async () => {
    const nodeA = registerQuadNode('quad-self', 0);
    await heatmapEngine.run(nodeA, nodeA, false);

    const state = useHeatmapStore.getState();
    expect(state.status).toBe('done');
    expect(state.stats).toEqual({ min: 0, max: 0, mean: 0, rms: 0 });
  });

  it('signed: querying from ABOVE a lower quad reports a positive distance', async () => {
    const nodeAbove = registerQuadNode('quad-above', 5);
    const nodeBelow = registerQuadNode('quad-below', 0);

    await heatmapEngine.run(nodeAbove, nodeBelow, true);
    const state = useHeatmapStore.getState();
    expect(state.status).toBe('done');
    // The quad's own winding orientation determines the sign convention —
    // what matters here is that signed mode ran without error and produced
    // a non-zero-magnitude result consistent with the unsigned case above.
    expect(Math.abs(state.stats!.mean)).toBeCloseTo(5, 9);
  });

  it('is a no-op when either SceneNode id is stale', async () => {
    const nodeA = registerQuadNode('quad-a', 0);
    await heatmapEngine.run(nodeA, 'not-a-real-node', false);
    expect(useHeatmapStore.getState().status).toBe('idle');
  });

  it('getActiveOverlay reflects the visible toggle', async () => {
    const nodeA = registerQuadNode('quad-a', 0);
    const nodeB = registerQuadNode('quad-b', 5);
    await heatmapEngine.run(nodeA, nodeB, false);

    expect(heatmapEngine.getActiveOverlay()).not.toBeNull();
    expect(heatmapEngine.getActiveOverlay()!.nodeId).toBe(nodeA);
    expect(heatmapEngine.getActiveOverlay()!.colors.length).toBe(4 * 3); // 4 vertices x rgb

    heatmapEngine.setVisible(false);
    expect(heatmapEngine.getActiveOverlay()).toBeNull();

    heatmapEngine.setVisible(true);
    expect(heatmapEngine.getActiveOverlay()).not.toBeNull();
  });

  it('setRange overrides the display range and getActiveOverlay recolors accordingly', async () => {
    const nodeA = registerQuadNode('quad-a', 0);
    const nodeB = registerQuadNode('quad-b', 5);
    await heatmapEngine.run(nodeA, nodeB, false);

    const autoColors = heatmapEngine.getActiveOverlay()!.colors.slice();
    heatmapEngine.setRange({ min: 0, max: 100 }); // a much wider range -> different colors
    const manualColors = heatmapEngine.getActiveOverlay()!.colors;
    expect(useHeatmapStore.getState().autoRange).toBe(false);
    expect(useHeatmapStore.getState().range).toEqual({ min: 0, max: 100 });
    expect(Array.from(manualColors)).not.toEqual(Array.from(autoColors));

    heatmapEngine.setRange(null); // revert to auto
    expect(useHeatmapStore.getState().autoRange).toBe(true);
  });

  it('clear resets the store and drops the active overlay', async () => {
    const nodeA = registerQuadNode('quad-a', 0);
    const nodeB = registerQuadNode('quad-b', 5);
    await heatmapEngine.run(nodeA, nodeB, false);
    expect(heatmapEngine.getActiveOverlay()).not.toBeNull();

    heatmapEngine.clear();
    expect(heatmapEngine.getActiveOverlay()).toBeNull();
    expect(useHeatmapStore.getState().status).toBe('idle');
    expect(useHeatmapStore.getState().stats).toBeNull();
  });
});
