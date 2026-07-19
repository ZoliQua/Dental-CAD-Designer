// alignment.test.ts — exercised through the REAL WorkerPool (Node
// worker_threads path), same rationale as ToolManager.test.ts: this
// module's job is orchestration (pick sequencing alternating src/dst,
// worker round trips, caseStore/journal wiring), not geometry — the
// geometry itself (coarseAlignFromPointTriples/icpRefine correctness) is
// already covered by packages/kernel/src/register's analytic tests and
// packages/kernel-workers/src/registerJob.test.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import type { IntakeReport, MeshStats } from '@dqcad/kernel-workers';
import type { Vec3 } from '@dqcad/shared-types';
import { useCaseStore } from '../state/caseStore';
import { useAlignmentStore } from '../state/alignmentStore';
import { alignmentEngine, type AlignPickRequest } from './alignment';
import { caseStore } from './caseStore';
import { resetBvhCacheForTests } from './workers';

const EMPTY_REPORT: IntakeReport = { weldEpsilonMm: 1e-6, steps: [] };

function statsForBbox(min: [number, number, number], max: [number, number, number]): MeshStats {
  return {
    watertight: true,
    manifoldEdges: true,
    componentCount: 1,
    bbox: { min, max },
    surfaceAreaMm2: 400,
    signedVolumeMm3: 100,
    degenerateCount: 0,
    boundaryEdgeCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Self-contained unit icosahedron pair (same construction as
// packages/kernel-workers/src/registerJob.test.ts's own local fixture — see
// that file's doc for why this isn't a shared import: kernel's TEST-ONLY
// fixture modules aren't part of any package's exports map).
// ---------------------------------------------------------------------------

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

type Mat3 = readonly [Vec3, Vec3, Vec3];

function rotationAboutAxis(axis: readonly [number, number, number], angleRad: number): Mat3 {
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

function applyRigid(r: Mat3, t: readonly [number, number, number], p: Vec3): Vec3 {
  return [
    r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2] + t[0],
    r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2] + t[1],
    r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2] + t[2],
  ];
}

const AXIS: readonly [number, number, number] = [0.2, 0.9, -0.3];
const ANGLE = 0.3;
const TRANSLATION: readonly [number, number, number] = [3, -1, 2];
const ROTATION = rotationAboutAxis(AXIS, ANGLE);

function registerIcosahedronNode(contentHash: string, offset: readonly [number, number, number]): { nodeId: string; positions: Float64Array; indices: Uint32Array } {
  const src = icosahedronBuffers();
  const positions = new Float64Array(src.positions.length);
  for (let i = 0; i < src.positions.length / 3; i++) {
    const p = applyRigid(
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      offset,
      [src.positions[i * 3]!, src.positions[i * 3 + 1]!, src.positions[i * 3 + 2]!],
    );
    positions.set(p, i * 3);
  }
  caseStore.registerImportedMesh({
    contentHash,
    name: `${contentHash}.stl`,
    format: 'stl',
    positions,
    indices: src.indices,
    stats: statsForBbox([-2 + offset[0], -2 + offset[1], -2 + offset[2]], [2 + offset[0], 2 + offset[1], 2 + offset[2]]),
    report: EMPTY_REPORT,
    operations: [],
  });
  const node = caseStore.addSceneNode(contentHash, 'situ');
  return { nodeId: node.id, positions, indices: src.indices };
}

/** Registers a src icosahedron at the origin and a dst icosahedron == the
 * SAME src vertices rigidly transformed by (ROTATION, TRANSLATION) — a
 * pair with an exact, known correct alignment answer. */
function registerKnownPair(): { srcNodeId: string; dstNodeId: string; srcPositions: Float64Array } {
  const src = registerIcosahedronNode('align-src', [0, 0, 0]);
  const dstPositions = new Float64Array(src.positions.length);
  for (let i = 0; i < src.positions.length / 3; i++) {
    const p = applyRigid(ROTATION, TRANSLATION, [src.positions[i * 3]!, src.positions[i * 3 + 1]!, src.positions[i * 3 + 2]!]);
    dstPositions.set(p, i * 3);
  }
  caseStore.registerImportedMesh({
    contentHash: 'align-dst',
    name: 'align-dst.stl',
    format: 'stl',
    positions: dstPositions,
    indices: src.indices,
    stats: statsForBbox([-4, -4, -4], [8, 8, 8]),
    report: EMPTY_REPORT,
    operations: [],
  });
  const dstNode = caseStore.addSceneNode('align-dst', 'antagonist');
  return { srcNodeId: src.nodeId, dstNodeId: dstNode.id, srcPositions: src.positions };
}

/** A ray cast from well outside the mesh, through `vertex`, toward the
 * mesh's own `center` — for a convex (icosahedron) mesh this reliably hits
 * the surface AT `vertex` itself (the ray passes exactly through it). Takes
 * an explicit `center` (NOT always the world origin) since dst's
 * icosahedron is centered at `TRANSLATION`, not the origin — a ray aimed at
 * the world origin from a dst vertex would miss dst's actual surface
 * entirely. */
function rayAtVertex(vertex: Vec3, center: readonly [number, number, number]): { rayOrigin: Vec3; rayDirection: Vec3 } {
  const offset: Vec3 = [vertex[0] - center[0], vertex[1] - center[1], vertex[2] - center[2]];
  const len = Math.hypot(offset[0], offset[1], offset[2]) || 1;
  const dir: Vec3 = [-offset[0] / len, -offset[1] / len, -offset[2] / len];
  const origin: Vec3 = [center[0] + offset[0] * 3, center[1] + offset[1] * 3, center[2] + offset[2] * 3];
  return { rayOrigin: origin, rayDirection: dir };
}

function pointAt(positions: Float64Array, i: number): Vec3 {
  return [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
}

beforeEach(() => {
  caseStore.resetForTests();
  alignmentEngine.resetForTests();
  resetBvhCacheForTests();
});

describe('alignmentEngine — full flow (pick 3 pairs, run, confirm)', () => {
  it('recovers the known rigid transform and journals alignment-apply on confirm', async () => {
    const { srcNodeId, dstNodeId, srcPositions } = registerKnownPair();

    alignmentEngine.startPicking(srcNodeId, dstNodeId);
    expect(useAlignmentStore.getState().phase).toBe('pickingPairs');

    // 3 vertex pairs — src vertices 0,1,2 correspond EXACTLY (by
    // construction) to dst vertices 0,1,2 (dst = ROTATION*src + TRANSLATION
    // applied to the SAME index order).
    for (let i = 0; i < 3; i++) {
      const srcVertex = pointAt(srcPositions, i);
      const dstVertex = applyRigid(ROTATION, TRANSLATION, srcVertex);

      const srcPick: AlignPickRequest = { candidateNodeIds: [srcNodeId, dstNodeId], ...rayAtVertex(srcVertex, [0, 0, 0]) };
      await alignmentEngine.handlePick(srcPick);
      expect(useAlignmentStore.getState().awaitingSide).toBe('dst');

      const dstPick: AlignPickRequest = { candidateNodeIds: [srcNodeId, dstNodeId], ...rayAtVertex(dstVertex, TRANSLATION) };
      await alignmentEngine.handlePick(dstPick);
    }

    expect(useAlignmentStore.getState().pairCount).toBe(3);
    expect(useAlignmentStore.getState().phase).toBe('ready');

    await alignmentEngine.run();
    const afterRun = useAlignmentStore.getState();
    expect(afterRun.phase).toBe('preview');
    expect(afterRun.result).not.toBeNull();
    expect(afterRun.result!.converged).toBe(true);
    expect(afterRun.result!.rmsMm).toBeLessThan(1e-3);
    expect(afterRun.result!.inlierFraction).toBeGreaterThan(0.5);

    // Nothing applied to the canonical SceneNode yet (no silent apply).
    expect(useCaseStore.getState().document.scene.find((n) => n.id === srcNodeId)!.transform).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    const historyBeforeConfirm = useCaseStore.getState().document.history.length;

    alignmentEngine.confirm();

    const doc = useCaseStore.getState().document;
    const srcNode = doc.scene.find((n) => n.id === srcNodeId)!;
    expect(srcNode.transform).not.toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

    expect(doc.history).toHaveLength(historyBeforeConfirm + 1);
    const op = doc.history[doc.history.length - 1]!;
    expect(op.name).toBe('alignment-apply');
    expect(op.params.transform).toEqual(srcNode.transform);
    expect(op.params.converged).toBe(true);
    expect(typeof op.params.seed).toBe('number');
    expect(op.outputHashes).toEqual([]);
    expect(op.inputHashes).toContain('align-src');
    expect(op.inputHashes).toContain('align-dst');

    // Resets to idle after confirm.
    expect(useAlignmentStore.getState().phase).toBe('idle');
  });
});

describe('alignmentEngine — cancel discards without applying', () => {
  it('cancel after picking pairs and running leaves the SceneNode untouched', async () => {
    const { srcNodeId, dstNodeId, srcPositions } = registerKnownPair();
    alignmentEngine.startPicking(srcNodeId, dstNodeId);

    for (let i = 0; i < 3; i++) {
      const srcVertex = pointAt(srcPositions, i);
      const dstVertex = applyRigid(ROTATION, TRANSLATION, srcVertex);
      await alignmentEngine.handlePick({ candidateNodeIds: [srcNodeId, dstNodeId], ...rayAtVertex(srcVertex, [0, 0, 0]) });
      await alignmentEngine.handlePick({ candidateNodeIds: [srcNodeId, dstNodeId], ...rayAtVertex(dstVertex, TRANSLATION) });
    }
    await alignmentEngine.run();
    expect(useAlignmentStore.getState().result).not.toBeNull();

    const historyBefore = useCaseStore.getState().document.history.length;
    alignmentEngine.cancel();

    expect(useAlignmentStore.getState().phase).toBe('idle');
    expect(useAlignmentStore.getState().result).toBeNull();
    expect(useCaseStore.getState().document.history).toHaveLength(historyBefore);
    expect(useCaseStore.getState().document.scene.find((n) => n.id === srcNodeId)!.transform).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
  });
});

describe('alignmentEngine — picking safety', () => {
  it('ignores a click on the wrong mesh (does not advance the pick count)', async () => {
    const { srcNodeId, dstNodeId, srcPositions } = registerKnownPair();
    alignmentEngine.startPicking(srcNodeId, dstNodeId);

    // First click SHOULD land on src, but this click targets a dst vertex
    // while dst is not yet the expected side — must be ignored.
    const dstVertex = applyRigid(ROTATION, TRANSLATION, pointAt(srcPositions, 0));
    await alignmentEngine.handlePick({ candidateNodeIds: [srcNodeId, dstNodeId], ...rayAtVertex(dstVertex, TRANSLATION) });
    expect(useAlignmentStore.getState().pairCount).toBe(0);
    expect(useAlignmentStore.getState().awaitingSide).toBe('src');
  });

  it('refuses to start picking when the source mesh already has a non-identity transform', () => {
    const { srcNodeId, dstNodeId } = registerKnownPair();
    caseStore.applyAlignment(
      srcNodeId,
      [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1],
      {
        id: 'op-1',
        name: 'alignment-apply',
        params: {},
        inputHashes: [],
        outputHashes: [],
        kernelVersion: '0.0.0',
        timestamp: new Date().toISOString(),
      },
    );
    expect(() => alignmentEngine.startPicking(srcNodeId, dstNodeId)).toThrow();
  });
});
