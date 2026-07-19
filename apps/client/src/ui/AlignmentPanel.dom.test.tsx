// apps/client/src/ui/AlignmentPanel.dom.test.tsx
//
// Phase 3 Task 3: real-DOM `client-dom` project test (browser mode — see
// apps/client/src/ui/README.md). Exercises the alignment tool's CRITICAL
// PATH end to end through the REAL rendered component + REAL kernel-workers
// WorkerPool (browser Web Worker path — buildBvh + icpRegister jobs), same
// "no-mock philosophy" as SurfaceDistancePanel.dom.test.tsx: select the two
// meshes via the real `<select>`s, start picking, run the (real,
// programmatically-driven — see below) alignment, confirm, and assert the
// SceneNode's transform + journal actually changed.
//
// Point-pair PICKS themselves are driven by calling `alignmentEngine.handlePick`
// directly (a ray + candidate set — the SAME shape SceneManager's real
// click handler reports) rather than simulating literal canvas mouse events:
// this file has no mounted `<Viewport>`/WebGL canvas (AlignmentPanel is a
// sidebar component, doesn't render the 3D view itself), and this is the
// same boundary ToolManager.test.ts's own coverage already draws (engine
// handles ray+candidates; SceneManager's own click-to-ray translation is
// covered separately, at the SceneManager/Viewport level — see
// engine/sceneTransform.dom.test.tsx for this task's Three.js-convention
// cross-check).
import { act } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { alignmentEngine, type AlignPickRequest } from '../engine/alignment';
import { caseStore } from '../engine/caseStore';
import { type MeshStats } from '../engine/repair';
import { useCaseStore } from '../state/caseStore';
import { useAlignmentStore } from '../state/alignmentStore';
import { AlignmentPanel } from './AlignmentPanel';

const EMPTY_REPORT = { weldEpsilonMm: 1e-6, steps: [] };

const ICOSA_STATS: MeshStats = {
  watertight: true,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [-2, -2, -2], max: [2, 2, 2] },
  surfaceAreaMm2: 40,
  signedVolumeMm3: 10,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};

function icosahedronBuffers(): { positions: Float64Array; indices: Uint32Array } {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: ReadonlyArray<readonly [number, number, number]> = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const faces: ReadonlyArray<readonly [number, number, number]> = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return { positions: new Float64Array(raw.flat()), indices: Uint32Array.from(faces.flat()) };
}

type Vec3 = readonly [number, number, number];
type Mat3 = readonly [Vec3, Vec3, Vec3];

function rotationAboutAxis(axis: Vec3, angleRad: number): Mat3 {
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  const [x, y, z] = [axis[0] / len, axis[1] / len, axis[2] / len];
  const s = Math.sin(angleRad);
  const c = Math.cos(angleRad);
  const tt = 1 - c;
  return [
    [tt * x * x + c, tt * x * y - s * z, tt * x * z + s * y],
    [tt * x * y + s * z, tt * y * y + c, tt * y * z - s * x],
    [tt * x * z - s * y, tt * y * z + s * x, tt * z * z + c],
  ];
}

function applyRigid(r: Mat3, t: Vec3, p: Vec3): Vec3 {
  return [
    r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2] + t[0],
    r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2] + t[1],
    r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2] + t[2],
  ];
}

const TRANSLATION: Vec3 = [3, -1, 2];
const ROTATION = rotationAboutAxis([0.2, 0.9, -0.3], 0.3);

function pointAt(positions: Float64Array, i: number): Vec3 {
  return [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
}

function rayAtVertex(vertex: Vec3, center: Vec3): { rayOrigin: Vec3; rayDirection: Vec3 } {
  const offset: Vec3 = [vertex[0] - center[0], vertex[1] - center[1], vertex[2] - center[2]];
  const len = Math.hypot(offset[0], offset[1], offset[2]) || 1;
  const dir: Vec3 = [-offset[0] / len, -offset[1] / len, -offset[2] / len];
  const origin: Vec3 = [center[0] + offset[0] * 3, center[1] + offset[1] * 3, center[2] + offset[2] * 3];
  return { rayOrigin: origin, rayDirection: dir };
}

function registerPair(): { srcNodeId: string; dstNodeId: string; srcPositions: Float64Array } {
  const src = icosahedronBuffers();
  caseStore.registerImportedMesh({
    contentHash: 'align-dom-src',
    name: 'src.stl',
    format: 'stl',
    positions: src.positions,
    indices: src.indices,
    stats: ICOSA_STATS,
    report: EMPTY_REPORT,
    operations: [],
  });
  const srcNode = caseStore.addSceneNode('align-dom-src', 'situ');

  const dstPositions = new Float64Array(src.positions.length);
  for (let i = 0; i < src.positions.length / 3; i++) {
    dstPositions.set(applyRigid(ROTATION, TRANSLATION, pointAt(src.positions, i)), i * 3);
  }
  caseStore.registerImportedMesh({
    contentHash: 'align-dom-dst',
    name: 'dst.stl',
    format: 'stl',
    positions: dstPositions,
    indices: src.indices,
    stats: ICOSA_STATS,
    report: EMPTY_REPORT,
    operations: [],
  });
  const dstNode = caseStore.addSceneNode('align-dom-dst', 'antagonist');

  return { srcNodeId: srcNode.id, dstNodeId: dstNode.id, srcPositions: src.positions };
}

beforeEach(() => {
  caseStore.resetForTests();
  alignmentEngine.resetForTests();
});

afterEach(() => {
  cleanup();
  caseStore.resetForTests();
  alignmentEngine.resetForTests();
});

describe('AlignmentPanel — critical path (real component, real store, real worker jobs)', () => {
  it('select meshes -> start -> pick 3 pairs -> run -> confirm updates the SceneNode transform and journals alignment-apply', async () => {
    const user = userEvent.setup();
    const { srcNodeId, dstNodeId, srcPositions } = registerPair();

    render(<AlignmentPanel />);

    await user.selectOptions(screen.getByTestId('alignment-mesh-src-select'), srcNodeId);
    await user.selectOptions(screen.getByTestId('alignment-mesh-dst-select'), dstNodeId);
    await user.click(screen.getByTestId('alignment-start-button'));

    await waitFor(() => {
      expect(screen.getByTestId('alignment-session')).toBeTruthy();
    });
    expect(useAlignmentStore.getState().phase).toBe('pickingPairs');

    for (let i = 0; i < 3; i++) {
      const srcVertex = pointAt(srcPositions, i);
      const dstVertex = applyRigid(ROTATION, TRANSLATION, srcVertex);
      const srcPick: AlignPickRequest = { candidateNodeIds: [srcNodeId, dstNodeId], ...rayAtVertex(srcVertex, [0, 0, 0]) };
      await act(async () => {
        await alignmentEngine.handlePick(srcPick);
      });
      const dstPick: AlignPickRequest = { candidateNodeIds: [srcNodeId, dstNodeId], ...rayAtVertex(dstVertex, TRANSLATION) };
      await act(async () => {
        await alignmentEngine.handlePick(dstPick);
      });
    }

    await waitFor(() => {
      expect(useAlignmentStore.getState().phase).toBe('ready');
    });

    await user.click(screen.getByTestId('alignment-run-button'));

    await waitFor(
      () => {
        expect(screen.getByTestId('alignment-result')).toBeTruthy();
      },
      { timeout: 10_000 },
    );
    expect(useAlignmentStore.getState().result?.converged).toBe(true);
    expect(screen.getByTestId('alignment-converged').textContent).toBe('Converged');

    const historyBefore = useCaseStore.getState().document.history.length;
    await user.click(screen.getByTestId('alignment-confirm-button'));

    await waitFor(() => {
      expect(useAlignmentStore.getState().phase).toBe('idle');
    });

    const doc = useCaseStore.getState().document;
    expect(doc.history).toHaveLength(historyBefore + 1);
    const op = doc.history[doc.history.length - 1]!;
    expect(op.name).toBe('alignment-apply');

    const srcNode = doc.scene.find((n) => n.id === srcNodeId)!;
    expect(srcNode.transform).not.toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(srcNode.transform).toEqual(op.params.transform);

    // Panel returns to the idle mesh-picker view.
    expect(screen.getByTestId('alignment-mesh-src-select')).toBeTruthy();
  });
});
