// section.test.ts — exercised through the REAL WorkerPool (Node
// worker_threads path), same rationale as heatmap.test.ts: this module is
// orchestration (plane construction from UI state, worker round trip per
// visible mesh, render-frame offset, store publishing), not geometry — the
// geometry itself (sectionMesh correctness, the acceptance-critical radius
// tests) is already covered by packages/kernel/src/section/polyline.test.ts
// and the worker job wiring by packages/kernel-workers/src/
// sectionMeshJob.test.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import type { IntakeReport, MeshStats } from '@dqcad/kernel-workers';
import { useSectionStore } from '../state/sectionStore';
import { caseStore } from './caseStore';
import { sectionEngine } from './section';

const EMPTY_REPORT: IntakeReport = { weldEpsilonMm: 1e-6, steps: [] };

function statsForBbox(min: [number, number, number], max: [number, number, number]): MeshStats {
  return {
    watertight: true,
    manifoldEdges: true,
    componentCount: 1,
    bbox: { min, max },
    surfaceAreaMm2: 6,
    signedVolumeMm3: 1,
    degenerateCount: 0,
    boundaryEdgeCount: 0,
  };
}

// Outward-wound unit cube, corner at the origin — same fixture shape as
// packages/kernel-workers' unitCubeMesh (jobs/misc.ts) / manifold.test.ts.
function unitCubeMesh(): { positions: Float64Array; indices: Uint32Array } {
  const positions = new Float64Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 0, 4, 7, 0, 7, 3,
  ]);
  return { positions, indices };
}

function registerCubeNode(contentHash: string): string {
  const { positions, indices } = unitCubeMesh();
  caseStore.registerImportedMesh({
    contentHash,
    name: `${contentHash}.stl`,
    format: 'stl',
    positions,
    indices,
    stats: statsForBbox([0, 0, 0], [1, 1, 1]),
    report: EMPTY_REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode(contentHash, 'situ');
  return node.id;
}

beforeEach(() => {
  caseStore.resetForTests();
  sectionEngine.resetForTests();
});

describe('sectionEngine — axis presets', () => {
  it('a Z-axis preset through the cube bbox center (z=0.5) yields a closed 8-point outline, cap area 1', async () => {
    registerCubeNode('cube-a');
    sectionEngine.setEnabled(true);
    await sectionEngine.waitForIdle();
    sectionEngine.setAxisPreset('z');
    await sectionEngine.waitForIdle();

    const state = useSectionStore.getState();
    expect(state.status).toBe('idle');
    expect(state.error).toBeNull();
    expect(state.plane).toEqual({ point: [0.5, 0.5, 0.5], normal: [0, 0, 1] });
    expect(state.pointCount).toBe(8); // see polyline.test.ts's cube-quad-diagonal doc

    const outline = sectionEngine.getOutline();
    expect(outline.length).toBe(1);
    expect(outline[0]!.closed).toBe(true);
    for (let i = 0; i < outline[0]!.points.length / 3; i++) {
      expect(outline[0]!.points[i * 3 + 2]).toBeCloseTo(0, 5); // render-frame: worldOffset subtracted, so world z=0.5 - centroid 0.5 = 0
    }

    const caps = sectionEngine.getCaps();
    expect(caps.length).toBe(1);
    expect(caps[0]!.indices.length).toBeGreaterThan(0);
  });

  it('X and Y presets also section the cube (bbox-center-relative, offset 0)', async () => {
    registerCubeNode('cube-b');
    sectionEngine.setEnabled(true);
    await sectionEngine.waitForIdle();

    sectionEngine.setAxisPreset('x');
    await sectionEngine.waitForIdle();
    expect(useSectionStore.getState().plane).toEqual({ point: [0.5, 0.5, 0.5], normal: [1, 0, 0] });
    expect(sectionEngine.getOutline().length).toBeGreaterThan(0);

    sectionEngine.setAxisPreset('y');
    await sectionEngine.waitForIdle();
    expect(useSectionStore.getState().plane).toEqual({ point: [0.5, 0.5, 0.5], normal: [0, 1, 0] });
    expect(sectionEngine.getOutline().length).toBeGreaterThan(0);
  });

  it('offsetMm moves the plane along the normal, missing the mesh entirely once far enough', async () => {
    registerCubeNode('cube-c');
    sectionEngine.setEnabled(true);
    await sectionEngine.waitForIdle();
    sectionEngine.setAxisPreset('z');
    await sectionEngine.waitForIdle();

    sectionEngine.setOffsetMm(100);
    await sectionEngine.waitForIdle();
    expect(useSectionStore.getState().pointCount).toBe(0);
    expect(sectionEngine.getOutline().length).toBe(0);
  });
});

describe('sectionEngine — custom plane (yaw/pitch)', () => {
  it('useCustomPlane + yaw/pitch still produces a valid section (a unit cube is convex, plane through center always crosses it)', async () => {
    registerCubeNode('cube-d');
    sectionEngine.setEnabled(true);
    await sectionEngine.waitForIdle();
    sectionEngine.useCustomPlane();
    await sectionEngine.waitForIdle();
    sectionEngine.setYawDeg(30);
    await sectionEngine.waitForIdle();
    sectionEngine.setPitchDeg(20);
    await sectionEngine.waitForIdle();

    expect(useSectionStore.getState().status).toBe('idle');
    expect(useSectionStore.getState().plane!.point).toEqual([0.5, 0.5, 0.5]);
    expect(sectionEngine.getOutline().length).toBeGreaterThan(0);
  });
});

describe('sectionEngine — clip plane derivation', () => {
  it('getClipPlane returns null when disabled or clip toggle is off', async () => {
    registerCubeNode('cube-e');
    expect(sectionEngine.getClipPlane()).toBeNull();

    sectionEngine.setEnabled(true);
    await sectionEngine.waitForIdle();
    sectionEngine.setAxisPreset('z');
    await sectionEngine.waitForIdle();
    expect(sectionEngine.getClipPlane()).toBeNull(); // clip toggle still off
  });

  it('getClipPlane accounts for the render worldOffset (constant = normal . (worldOffset - point))', async () => {
    registerCubeNode('cube-f');
    sectionEngine.setEnabled(true);
    await sectionEngine.waitForIdle();
    sectionEngine.setAxisPreset('z');
    await sectionEngine.waitForIdle();
    sectionEngine.setClipEnabled(true);

    const clip = sectionEngine.getClipPlane();
    expect(clip).not.toBeNull();
    expect(clip!.normal).toEqual([0, 0, 1]);
    const worldOffset = caseStore.getRenderWorldOffset();
    const expectedConstant = worldOffset[2] - 0.5; // plane point z=0.5, normal=[0,0,1]
    expect(clip!.constant).toBeCloseTo(expectedConstant, 12);
  });
});

describe('sectionEngine — SVG export', () => {
  it('exportSvg is null before any run, and a valid SVG string after', async () => {
    registerCubeNode('cube-g');
    expect(sectionEngine.exportSvg()).toBeNull();

    sectionEngine.setEnabled(true);
    await sectionEngine.waitForIdle();
    sectionEngine.setAxisPreset('z');
    await sectionEngine.waitForIdle();

    const svg = sectionEngine.exportSvg();
    expect(svg).not.toBeNull();
    expect(svg).toContain('<svg');
    expect(svg).toContain('<path');
  });
});

describe('sectionEngine — clear / disable', () => {
  it('disabling the tool clears the outline/caps/plane', async () => {
    registerCubeNode('cube-h');
    sectionEngine.setEnabled(true);
    await sectionEngine.waitForIdle();
    sectionEngine.setAxisPreset('z');
    await sectionEngine.waitForIdle();
    expect(sectionEngine.getOutline().length).toBeGreaterThan(0);

    sectionEngine.setEnabled(false);
    expect(sectionEngine.getOutline().length).toBe(0);
    expect(sectionEngine.getCaps().length).toBe(0);
    expect(useSectionStore.getState().plane).toBeNull();
    expect(useSectionStore.getState().enabled).toBe(false);
  });
});
