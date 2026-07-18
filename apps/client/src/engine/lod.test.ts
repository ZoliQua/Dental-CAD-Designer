// lod.test.ts — Phase 2 Task 10's engine wiring, exercised through the REAL
// WorkerPool (Node worker_threads path), same rationale as heatmap.test.ts:
// this module is orchestration (worker round trip, meshStore attach, store
// publishing, render-copy selection), not geometry — the decimation itself
// is exhaustively covered by packages/kernel/src/decimate/*.test.ts and the
// job by packages/kernel-workers/src/decimateJob.test.ts.
//
// The tests here pin this task's HARD INVARIANT from the engine side: the
// Float64 kernel master buffers are byte-identical (SHA-256-checked) before
// and after an LOD build, LODs only ever appear as a SEPARATE render copy,
// and the measurement path's inputs (caseStore.getMeshRecord's master
// buffers — what ToolManager.handlePick feeds ensureBvhBuilt/raycastMesh)
// never change identity or content.
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IntakeReport, MeshStats } from '@dqcad/kernel-workers';
import { useLodStore } from '../state/lodStore';
import { caseStore } from './caseStore';
import { lodEngine } from './lod';
import {
  RENDER_LOD_TRIANGLE_BUDGET,
  RENDER_LOD_TARGET_FRACTION,
  lodTargetTriangleCount,
  shouldUseLod,
} from './lodPolicy';

const EMPTY_REPORT: IntakeReport = { weldEpsilonMm: 1e-6, steps: [] };

function statsForBbox(min: [number, number, number], max: [number, number, number]): MeshStats {
  return {
    watertight: true,
    manifoldEdges: true,
    componentCount: 1,
    bbox: { min, max },
    surfaceAreaMm2: 400,
    signedVolumeMm3: 500,
    degenerateCount: 0,
    boundaryEdgeCount: 0,
  };
}

/** Deterministic closed UV sphere — big enough (~2k triangles) that a 20%
 * LOD is meaningfully smaller, small enough to decimate in milliseconds. */
function uvSphere(radius: number, rings: number, segments: number): { positions: Float64Array; indices: Uint32Array } {
  const positions: number[] = [0, 0, radius];
  for (let r = 1; r < rings; r++) {
    const phi = (Math.PI * r) / rings;
    for (let s = 0; s < segments; s++) {
      const theta = (2 * Math.PI * s) / segments;
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
      );
    }
  }
  positions.push(0, 0, -radius);
  const southIndex = positions.length / 3 - 1;
  const ringStart = (r: number): number => 1 + (r - 1) * segments;
  const indices: number[] = [];
  for (let s = 0; s < segments; s++) {
    indices.push(0, ringStart(1) + s, ringStart(1) + ((s + 1) % segments));
  }
  for (let r = 1; r < rings - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const a = ringStart(r) + s;
      const b = ringStart(r) + ((s + 1) % segments);
      const c = ringStart(r + 1) + ((s + 1) % segments);
      const d = ringStart(r + 1) + s;
      indices.push(a, c, b, a, d, c);
    }
  }
  for (let s = 0; s < segments; s++) {
    indices.push(southIndex, ringStart(rings - 1) + ((s + 1) % segments), ringStart(rings - 1) + s);
  }
  return { positions: new Float64Array(positions), indices: Uint32Array.from(indices) };
}

function hashBuffers(positions: Float64Array, indices: Uint32Array): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  return hash.digest('hex');
}

function registerSphereNode(contentHash: string): string {
  const { positions, indices } = uvSphere(10, 32, 32);
  caseStore.registerImportedMesh({
    contentHash,
    name: `${contentHash}.stl`,
    format: 'stl',
    positions,
    indices,
    stats: statsForBbox([-10, -10, -10], [10, 10, 10]),
    report: EMPTY_REPORT,
    operations: [],
  });
  return caseStore.addSceneNode(contentHash, 'situ').id;
}

/** Polls until the LOD build for `contentHash` settles (ready/error) —
 * lodEngine's builds are fire-and-forget, published via state/lodStore. */
async function waitForLodBuild(contentHash: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const status = useLodStore.getState().buildStatus[contentHash];
    if (status === 'ready' || status === 'error') return;
    if (Date.now() - start > timeoutMs) throw new Error(`LOD build for ${contentHash} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(() => {
  caseStore.resetForTests();
  lodEngine.resetForTests();
});

describe('lodPolicy — threshold logic (unit)', () => {
  it("'auto' uses the LOD strictly above the budget, never at/below it", () => {
    expect(shouldUseLod('auto', RENDER_LOD_TRIANGLE_BUDGET - 1)).toBe(false);
    expect(shouldUseLod('auto', RENDER_LOD_TRIANGLE_BUDGET)).toBe(false);
    expect(shouldUseLod('auto', RENDER_LOD_TRIANGLE_BUDGET + 1)).toBe(true);
  });

  it("'on' forces the LOD regardless of size; 'off' never uses it", () => {
    expect(shouldUseLod('on', 10)).toBe(true);
    expect(shouldUseLod('on', RENDER_LOD_TRIANGLE_BUDGET * 10)).toBe(true);
    expect(shouldUseLod('off', 10)).toBe(false);
    expect(shouldUseLod('off', RENDER_LOD_TRIANGLE_BUDGET * 10)).toBe(false);
  });

  it('lodTargetTriangleCount is the target fraction, capped at the budget', () => {
    expect(lodTargetTriangleCount(1000)).toBe(Math.round(1000 * RENDER_LOD_TARGET_FRACTION));
    const huge = RENDER_LOD_TRIANGLE_BUDGET * 10;
    expect(lodTargetTriangleCount(huge)).toBe(RENDER_LOD_TRIANGLE_BUDGET);
  });
});

describe('lodEngine — build + render-copy selection', () => {
  it(
    'builds an LOD (mode on), leaves the Float64 kernel masters byte-identical, and swaps ONLY the render copy',
    { timeout: 60_000 },
    async () => {
      const nodeId = registerSphereNode('lod-sphere');
      const record = caseStore.getMeshRecord('lod-sphere')!;
      const masterPositionsRef = record.positions;
      const masterIndicesRef = record.indices;
      const masterHashBefore = hashBuffers(record.positions, record.indices);
      const fullResTriangleCount = record.indices.length / 3;

      // Below the budget, so 'auto' must NOT build/use an LOD.
      useLodStore.getState().setMode('auto');
      lodEngine.syncLodBuilds();
      expect(useLodStore.getState().buildStatus['lod-sphere']).toBeUndefined();
      expect(record.lod).toBeUndefined();

      // Force on (the dev toggle) — now a build must happen.
      useLodStore.getState().setMode('on');
      lodEngine.syncLodBuilds();
      await waitForLodBuild('lod-sphere');
      expect(useLodStore.getState().buildStatus['lod-sphere']).toBe('ready');

      // The LOD is attached, meaningfully smaller, and render-frame sized.
      const lod = caseStore.getMeshRecord('lod-sphere')!.lod!;
      expect(lod.indices.length / 3).toBeLessThanOrEqual(lodTargetTriangleCount(fullResTriangleCount));
      expect(lod.renderPositions.length).toBe(lod.positions.length);
      expect(lod.maxErrorMm).toBeGreaterThan(0);

      // HARD INVARIANT: the Float64 kernel masters are the SAME arrays,
      // byte-identical — nothing about the LOD build touched them. These
      // masters are exactly what the measurement path consumes
      // (ToolManager.handlePick -> ensureBvhBuilt(record.positions,
      // record.indices) -> raycastMesh), so this also pins "picking/
      // measuring still routes to full-res".
      expect(record.positions).toBe(masterPositionsRef);
      expect(record.indices).toBe(masterIndicesRef);
      expect(hashBuffers(record.positions, record.indices)).toBe(masterHashBefore);

      // Render-node selection: 'on' serves the LOD buffers…
      const lodNodes = caseStore.getRenderNodes();
      const lodNode = lodNodes.find((node) => node.id === nodeId)!;
      expect(lodNode.positions).toBe(lod.renderPositions);
      expect(lodNode.indices).toBe(lod.indices);

      // …and 'off' immediately serves the full-res copy again (the LOD
      // stays attached for later re-enable — nothing is rebuilt/dropped).
      useLodStore.getState().setMode('off');
      const fullNodes = caseStore.getRenderNodes();
      const fullNode = fullNodes.find((node) => node.id === nodeId)!;
      expect(fullNode.positions).toBe(record.renderPositions);
      expect(fullNode.indices).toBe(record.renderIndices);
      expect(fullNode.indices.length / 3).toBe(fullResTriangleCount);
    },
  );

  it("'auto' with a below-budget mesh serves full-res even when an LOD exists", { timeout: 60_000 }, async () => {
    const nodeId = registerSphereNode('lod-sphere-auto');
    useLodStore.getState().setMode('on');
    lodEngine.syncLodBuilds();
    await waitForLodBuild('lod-sphere-auto');

    useLodStore.getState().setMode('auto');
    const node = caseStore.getRenderNodes().find((renderNode) => renderNode.id === nodeId)!;
    const record = caseStore.getMeshRecord('lod-sphere-auto')!;
    expect(record.lod).toBeDefined(); // built…
    expect(node.positions).toBe(record.renderPositions); // …but not used below the budget
  });

  it('a mesh removed mid-build drops the stale LOD result without error', { timeout: 60_000 }, async () => {
    const nodeId = registerSphereNode('lod-sphere-removed');
    useLodStore.getState().setMode('on');
    lodEngine.syncLodBuilds();
    // Remove the scene node (and thereby the mesh record) while the LOD
    // job may still be in flight.
    caseStore.removeSceneNode(nodeId);
    // Wait for the build to settle either way — the engine must not throw,
    // and no LOD may be attached to a removed record.
    const start = Date.now();
    while (useLodStore.getState().buildStatus['lod-sphere-removed'] === 'building') {
      if (Date.now() - start > 30_000) throw new Error('LOD build did not settle');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(caseStore.getMeshRecord('lod-sphere-removed')).toBeUndefined();
  });
});
