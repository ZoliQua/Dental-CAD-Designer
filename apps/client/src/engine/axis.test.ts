// axis.test.ts — exercised through the REAL WorkerPool (Node worker_threads
// path), same rationale as section.test.ts/heatmap.test.ts: this module is
// orchestration (session lifecycle, worker round trips, journaling,
// heatmap color mapping), not geometry — the geometry itself (region
// extraction, coarse->fine search, objective) is already covered by
// packages/kernel/src/axis/*.test.ts, and the worker job wiring by
// packages/kernel-workers/src/axisJobs.test.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import type { IntakeReport, MeshStats } from '@dqcad/kernel-workers';
import type { MarginAnchor, MarginLine, Restoration } from '@dqcad/shared-types';
import { DEFAULT_RESTORATION_PARAMS } from '@dqcad/clinical-profiles';
import { useAxisStore } from '../state/axisStore';
import { caseStore } from './caseStore';
import { axisEngine, sphericalToDirection, directionToSpherical } from './axis';

const EMPTY_REPORT: IntakeReport = { weldEpsilonMm: 1e-6, steps: [] };

function statsForBbox(min: [number, number, number], max: [number, number, number]): MeshStats {
  return {
    watertight: true,
    manifoldEdges: true,
    componentCount: 1,
    bbox: { min, max },
    surfaceAreaMm2: 1,
    signedVolumeMm3: 1,
    degenerateCount: 0,
    boundaryEdgeCount: 0,
  };
}

// ---------------------------------------------------------------------------
// A capped cone frustum (bottom ring WIDER than the top — draft toward +Z,
// true axis [0,0,1]) with several intermediate wall rings — mirrors
// packages/kernel/src/axis/axis.test-fixtures.ts's `coneFrustumMesh` /
// packages/kernel-workers/src/axisJobs.test.ts's own duplicated builder
// (this repo's established "duplicate small fixture logic per test file"
// convention, now a 3rd copy — consistent with e.g. undercutJobs.test.ts's
// own precedent).
// ---------------------------------------------------------------------------

const BOTTOM_RADIUS = 4;
const TOP_RADIUS = 2.5;
const HEIGHT = 9;
const SEGMENTS = 32;
const HEIGHT_SEGMENTS = 8;

function frustumMeshBuffers(): {
  positions: Float64Array;
  indices: Uint32Array;
  wallSeed: (ring: number, seg: number) => MarginAnchor;
} {
  const ringIndex = (ring: number, seg: number): number => ring * SEGMENTS + seg;
  const positions: number[] = [];
  for (let r = 0; r <= HEIGHT_SEGMENTS; r++) {
    const t = r / HEIGHT_SEGMENTS;
    const z = t * HEIGHT;
    const radius = BOTTOM_RADIUS + (TOP_RADIUS - BOTTOM_RADIUS) * t;
    for (let s = 0; s < SEGMENTS; s++) {
      const theta = (2 * Math.PI * s) / SEGMENTS;
      positions.push(radius * Math.cos(theta), radius * Math.sin(theta), z);
    }
  }
  const bottomCenterIndex = positions.length / 3;
  positions.push(0, 0, 0);
  const topCenterIndex = positions.length / 3;
  positions.push(0, 0, HEIGHT);

  const indices: number[] = [];
  const wallTriangleIndexOf = new Map<string, number>();
  for (let r = 0; r < HEIGHT_SEGMENTS; r++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const sNext = (s + 1) % SEGMENTS;
      const a = ringIndex(r, s);
      const b = ringIndex(r, sNext);
      const c = ringIndex(r + 1, sNext);
      const d = ringIndex(r + 1, s);
      wallTriangleIndexOf.set(`${r},${s}`, indices.length / 3);
      indices.push(a, b, c);
      indices.push(a, c, d);
    }
  }
  for (let s = 0; s < SEGMENTS; s++) {
    const sNext = (s + 1) % SEGMENTS;
    indices.push(bottomCenterIndex, ringIndex(0, sNext), ringIndex(0, s));
  }
  for (let s = 0; s < SEGMENTS; s++) {
    const sNext = (s + 1) % SEGMENTS;
    indices.push(topCenterIndex, ringIndex(HEIGHT_SEGMENTS, s), ringIndex(HEIGHT_SEGMENTS, sNext));
  }

  const flatPositions = Float64Array.from(positions);
  return {
    positions: flatPositions,
    indices: Uint32Array.from(indices),
    wallSeed: (ring, seg) => {
      const key = `${Math.min(ring, HEIGHT_SEGMENTS - 1)},${seg}`;
      const triangleIndex = wallTriangleIndexOf.get(key)!;
      const i0 = indices[triangleIndex * 3]!;
      return {
        position: [flatPositions[i0 * 3]!, flatPositions[i0 * 3 + 1]!, flatPositions[i0 * 3 + 2]!],
        triangleIndex,
        barycentric: [1, 0, 0],
      };
    },
  };
}

function midWallLoop(fixture: ReturnType<typeof frustumMeshBuffers>, ring: number): MarginAnchor[] {
  const loop: MarginAnchor[] = [];
  for (let s = 0; s < SEGMENTS; s++) {
    loop.push(fixture.wallSeed(ring, s));
  }
  return loop;
}

/** Registers the frustum mesh, a scene node, and a crown restoration with
 * tooth 11's margin line already confirmed (mid-wall ring 3) — returns the
 * restoration id. */
function setupCrownRestoration(): { restorationId: string; targetNodeId: string } {
  const fixture = frustumMeshBuffers();
  caseStore.registerImportedMesh({
    contentHash: 'axis-engine-frustum',
    name: 'frustum.stl',
    format: 'stl',
    positions: fixture.positions,
    indices: fixture.indices,
    stats: statsForBbox([-4, -4, 0], [4, 4, 9]),
    report: EMPTY_REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode('axis-engine-frustum', 'prepDie');

  const marginLine: MarginLine = { anchors: midWallLoop(fixture, 3), closed: true };
  const restoration: Restoration = {
    id: 'restoration-axis-1',
    type: 'crown',
    teeth: [11],
    pontics: [],
    targetNodeId: node.id,
    marginLines: { 11: marginLine },
    insertionAxis: [0, 0, 1],
    params: DEFAULT_RESTORATION_PARAMS,
    stages: {},
    qc: null,
  };
  caseStore.addRestoration(restoration, {
    id: 'op-1',
    name: 'restoration-create',
    params: {},
    inputHashes: [],
    outputHashes: [],
    kernelVersion: '0.0.0-test',
    timestamp: new Date().toISOString(),
  });
  return { restorationId: restoration.id, targetNodeId: node.id };
}

beforeEach(() => {
  caseStore.resetForTests();
  axisEngine.resetForTests();
});

describe('sphericalToDirection / directionToSpherical', () => {
  it('round-trips a variety of directions', () => {
    const cases: [number, number, number][] = [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
      [0.5, 0.5, 0.7071],
      [-0.3, 0.6, 0.7],
    ];
    for (const dir of cases) {
      const len = Math.hypot(dir[0], dir[1], dir[2]);
      const unit: [number, number, number] = [dir[0] / len, dir[1] / len, dir[2] / len];
      const { azimuthDeg, elevationDeg } = directionToSpherical(unit);
      const back = sphericalToDirection(azimuthDeg, elevationDeg);
      expect(back[0]).toBeCloseTo(unit[0], 6);
      expect(back[1]).toBeCloseTo(unit[1], 6);
      expect(back[2]).toBeCloseTo(unit[2], 6);
    }
  });

  it('elevation +90 gives exactly [0,0,1] regardless of azimuth', () => {
    expect(sphericalToDirection(37, 90)[2]).toBeCloseTo(1, 9);
  });
});

describe('axisEngine — session lifecycle', () => {
  it('throws if the restoration has no target scan', () => {
    const restoration: Restoration = {
      id: 'r-no-target',
      type: 'crown',
      teeth: [11],
      pontics: [],
      targetNodeId: null,
      marginLines: {},
      insertionAxis: [0, 0, 1],
      params: DEFAULT_RESTORATION_PARAMS,
      stages: {},
      qc: null,
    };
    caseStore.addRestoration(restoration, {
      id: 'op', name: 'restoration-create', params: {}, inputHashes: [], outputHashes: [], kernelVersion: '0.0.0-test', timestamp: new Date().toISOString(),
    });
    expect(() => axisEngine.start('r-no-target')).toThrow(/target scan/);
  });

  it('throws if the restoration has no confirmed margin line', () => {
    setupCrownRestoration();
    const restoration: Restoration = {
      id: 'r-no-margin',
      type: 'crown',
      teeth: [12],
      pontics: [],
      targetNodeId: caseStore.getDocument().scene[0]!.id,
      marginLines: {},
      insertionAxis: [0, 0, 1],
      params: DEFAULT_RESTORATION_PARAMS,
      stages: {},
      qc: null,
    };
    caseStore.addRestoration(restoration, {
      id: 'op2', name: 'restoration-create', params: {}, inputHashes: [], outputHashes: [], kernelVersion: '0.0.0-test', timestamp: new Date().toISOString(),
    });
    expect(() => axisEngine.start('r-no-margin')).toThrow(/margin line/);
  });

  it('start() initializes the store with the restoration\'s persisted axis and abutment teeth', () => {
    const { restorationId, targetNodeId } = setupCrownRestoration();
    axisEngine.start(restorationId);
    const state = useAxisStore.getState();
    expect(state.restorationId).toBe(restorationId);
    expect(state.targetNodeId).toBe(targetNodeId);
    expect(state.abutmentTeeth).toEqual([11]);
    expect(state.direction).toEqual([0, 0, 1]);
    expect(state.status).toBe('active');
  });
});

describe('axisEngine — runSuggest', () => {
  it('suggests an axis close to the frustum\'s true construction axis, populates ranked + perAbutment, and computes a heatmap', async () => {
    const { restorationId } = setupCrownRestoration();
    axisEngine.start(restorationId);
    await axisEngine.runSuggest();

    const state = useAxisStore.getState();
    expect(state.status).toBe('active');
    expect(state.error).toBeNull();
    expect(state.ranked.length).toBeGreaterThan(0);
    expect(state.perAbutment.length).toBe(1);
    expect(state.perAbutment[0]!.tooth).toBe(11);
    expect(state.source).toBe('suggested');

    // True axis is [0,0,1] — a generous bound (kernel-level analytic tests
    // own the tight, derived tolerance).
    const [dx, dy, dz] = state.direction;
    const len = Math.hypot(dx, dy, dz);
    const angleDeg = (Math.acos(Math.min(1, Math.max(-1, dz / len))) * 180) / Math.PI;
    expect(angleDeg).toBeLessThan(20);

    // Heatmap was recomputed as a side effect of the suggestion.
    const overlay = axisEngine.getHeatmapOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay!.nodeId).toBe(state.targetNodeId);
    expect(overlay!.colors.length).toBeGreaterThan(0);
  });
});

describe('axisEngine — manual adjust', () => {
  it('setAzimuthDeg/setElevationDeg update direction and provenance, and refresh the heatmap', async () => {
    const { restorationId } = setupCrownRestoration();
    axisEngine.start(restorationId);
    await axisEngine.runSuggest();
    const generationBefore = useAxisStore.getState().heatmapGeneration;

    axisEngine.setElevationDeg(80);
    // setElevationDeg fires the heatmap refresh asynchronously (fire-and-
    // forget) — poll briefly for it to land, same pattern as
    // section.test.ts's `waitForIdle` where a dedicated await isn't wired.
    for (let i = 0; i < 50 && useAxisStore.getState().heatmapGeneration === generationBefore; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const state = useAxisStore.getState();
    expect(state.source).toBe('manual');
    expect(state.elevationDeg).toBe(80);
    expect(state.confirmed).toBe(false);
    expect(state.heatmapGeneration).toBeGreaterThan(generationBefore);
  });
});

describe('axisEngine — confirmAxis', () => {
  it('journals an axis-set Operation and stamps insertionAxis on the restoration', async () => {
    const { restorationId } = setupCrownRestoration();
    axisEngine.start(restorationId);
    await axisEngine.runSuggest();
    const suggestedDirection = useAxisStore.getState().direction;

    axisEngine.confirmAxis();

    const restoration = caseStore.getDocument().restorations.find((r) => r.id === restorationId)!;
    expect(restoration.insertionAxis).toEqual(suggestedDirection);
    const lastOp = caseStore.getDocument().history[caseStore.getDocument().history.length - 1]!;
    expect(lastOp.name).toBe('axis-set');
    expect(lastOp.params.restorationId).toBe(restorationId);
    expect(lastOp.params.source).toBe('suggested');
    expect(useAxisStore.getState().confirmed).toBe(true);
  });

  it('throws if called with no active session', () => {
    expect(() => axisEngine.confirmAxis()).toThrow(/no active session/);
  });
});
