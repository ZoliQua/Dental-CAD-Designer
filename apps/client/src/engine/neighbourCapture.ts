// apps/client/src/engine/neighbourCapture.ts
//
// Phase 9 Task 3 (ADR-022 Decision 3) — neighbours and antagonist from the
// case's OWN scans, shared by the crown and cavity controllers:
//
//  - which arch scan holds the restoration's neighbours (`findArchScan`: the
//    restoration's target if it is that tooth's jaw scan, else the case's
//    scan with that jaw role) and which one is the opposite arch
//    (`findOppositeArchScan`) — by FDI quadrant, never by world axes;
//  - the capture itself (`runNeighbourCapture`): the `extractNeighbourRegion`
//    worker job on the arch scan at the user's pick, content-addressed;
//  - the journal: a capture is one `NEIGHBOUR_CAPTURE_OP` (scan hash in,
//    region hash out, the pick + window in params); the opposite-arch
//    antagonist is used only after an explicit `ANTAGONIST_CONFIRM_OP` (no
//    silent role inference). The server traces `case` contact claims to
//    these ops (apps/server/src/export-provenance.ts).
//
// Layer rule: engine → kernel-workers / shared-types only.
import type { JobName, JobPayloadMap, JobResultMap, RunJobOptions } from '@dqcad/kernel-workers';
import {
  ANTAGONIST_CONFIRM_OP,
  NEIGHBOUR_CAPTURE_OP,
  type CaseDocument,
  type FdiTooth,
  type NeighbourSide,
  type Operation,
  type SceneNode,
  type Vec3,
} from '@dqcad/shared-types';

/** Structural view of a pool (WorkerPool, or a node-lane fake). */
interface CapturePool {
  run<J extends JobName>(
    jobName: J,
    payload: JobPayloadMap[J],
    opts?: RunJobOptions,
  ): Promise<JobResultMap[J]>;
}

export type ArchRole = 'upperJaw' | 'lowerJaw';

/** Quadrants 1–2 are the upper jaw, 3–4 the lower jaw. */
export function jawOfTooth(tooth: FdiTooth): ArchRole {
  const quadrant = Math.floor(tooth / 10);
  return quadrant === 1 || quadrant === 2 ? 'upperJaw' : 'lowerJaw';
}

/** The FDI neighbours: mesial toward the midline (a central incisor's mesial
 * neighbour is the other quadrant's central incisor), distal away from it,
 * none past the third molar. */
export function adjacentTeeth(tooth: FdiTooth): {
  mesial: FdiTooth | null;
  distal: FdiTooth | null;
} {
  const quadrant = Math.floor(tooth / 10);
  const index = tooth % 10;
  const across: Record<number, number> = { 1: 2, 2: 1, 3: 4, 4: 3 };
  const mesial = index === 1 ? across[quadrant]! * 10 + 1 : quadrant * 10 + index - 1;
  const distal = index === 8 ? null : quadrant * 10 + index + 1;
  return { mesial: mesial as FdiTooth, distal: distal as FdiTooth | null };
}

/** The scan holding `tooth`'s neighbours: the restoration's target when it
 * is that jaw's scan, else the first scene node with that jaw role. */
export function findArchScan(
  document: CaseDocument,
  tooth: FdiTooth,
  targetNodeId: string | null,
): SceneNode | null {
  const jaw = jawOfTooth(tooth);
  const target = document.scene.find((n) => n.id === targetNodeId);
  if (target && target.role === jaw) return target;
  return document.scene.find((n) => n.role === jaw) ?? null;
}

/** The opposite-arch scan (offered as antagonist after confirmation). */
export function findOppositeArchScan(document: CaseDocument, tooth: FdiTooth): SceneNode | null {
  const opposite: ArchRole = jawOfTooth(tooth) === 'upperJaw' ? 'lowerJaw' : 'upperJaw';
  return document.scene.find((n) => n.role === opposite) ?? null;
}

/** The latest `NEIGHBOUR_CAPTURE_OP` for this restoration and side. */
export function latestNeighbourCapture(
  history: readonly Operation[],
  restorationId: string,
  side: NeighbourSide,
): Operation | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const op = history[i]!;
    if (
      op.name === NEIGHBOUR_CAPTURE_OP &&
      op.params['restorationId'] === restorationId &&
      op.params['side'] === side
    ) {
      return op;
    }
  }
  return undefined;
}

/** The scan node the user confirmed as this restoration's antagonist (the
 * latest `ANTAGONIST_CONFIRM_OP` whose scan is still in the scene), or null. */
export function confirmedAntagonistNodeId(
  document: CaseDocument,
  restorationId: string,
): string | null {
  for (let i = document.history.length - 1; i >= 0; i--) {
    const op = document.history[i]!;
    if (op.name !== ANTAGONIST_CONFIRM_OP || op.params['restorationId'] !== restorationId) continue;
    const nodeId = op.params['scanNodeId'];
    const node = document.scene.find((n) => n.id === nodeId);
    return node && op.inputHashes[0] === node.meshId ? node.id : null;
  }
  return null;
}

/** Which input a capture fills: a proximal side, or the antagonist. */
export type CaptureRole = NeighbourSide | 'antagonist';

/** A neighbour (or the antagonist) captured from a case scan — a closed,
 * case-derived solid. */
export interface CapturedNeighbour {
  side: CaptureRole;
  scanNodeId: string;
  scanMeshId: string;
  seed: Vec3;
  positions: Float64Array;
  indices: Uint32Array;
  contentHash: string;
  capturedTriangleCount: number;
  capturedAreaMm2: number;
  /** The capture's `@errorBound` on missed contact surface (mm). */
  windowBoundaryBandMm: number;
  /** Journal params (the replayable window). */
  params: Record<string, unknown>;
}

export interface NeighbourCaptureInput {
  side: CaptureRole;
  scanNode: SceneNode;
  scan: { positions: Float64Array; indices: Uint32Array; contentHash: string };
  seed: Vec3;
  marginLoopFlat: Float64Array;
  insertionAxis: Vec3;
}

/** The margin-loop centroid — journaled so a restored capture can check the
 * margin it was cut against is still the current one. */
export function loopCentroid(flat: Float64Array): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  const n = flat.length / 3;
  for (let i = 0; i < flat.length; i += 3) {
    x += flat[i]!;
    y += flat[i + 1]!;
    z += flat[i + 2]!;
  }
  return [x / n, y / n, z / n];
}

/** Runs the capture: BVH on the arch scan, `extractNeighbourRegion` at the
 * pick, then the region's content hash. Deterministic given the inputs. */
export async function runNeighbourCapture(
  pool: CapturePool,
  input: NeighbourCaptureInput,
): Promise<CapturedNeighbour> {
  const { contentHash } = input.scan;
  const positionsCopy = input.scan.positions.slice();
  const indicesCopy = input.scan.indices.slice();
  await pool.run(
    'buildBvh',
    { contentHash, positions: positionsCopy, indices: indicesCopy },
    { transfer: [positionsCopy.buffer, indicesCopy.buffer], affinityKey: contentHash },
  );
  return extractOnCachedScan(pool, input);
}

async function extractOnCachedScan(
  pool: CapturePool,
  input: NeighbourCaptureInput,
): Promise<CapturedNeighbour> {
  const { contentHash } = input.scan;
  const r = await pool.run(
    'extractNeighbourRegion',
    {
      contentHash,
      seed: input.seed,
      marginLoop: input.marginLoopFlat,
      insertionAxis: input.insertionAxis,
      ...(input.side === 'antagonist' ? { options: { approach: 'occlusal' as const } } : {}),
    },
    { affinityKey: contentHash },
  );
  const hashed = await pool.run('hashMesh', { positions: r.positions, indices: r.indices });
  return {
    side: input.side,
    scanNodeId: input.scanNode.id,
    scanMeshId: input.scanNode.meshId,
    seed: input.seed,
    positions: r.positions,
    indices: r.indices,
    contentHash: hashed.contentHash,
    capturedTriangleCount: r.capturedTriangleCount,
    capturedAreaMm2: r.capturedAreaMm2,
    windowBoundaryBandMm: r.windowBoundaryBandMm,
    params: {
      side: input.side,
      scanNodeId: input.scanNode.id,
      seed: input.seed,
      seedOnSurface: r.seedOnSurface,
      approachDirection: r.approachDirection,
      approach: r.approach,
      insertionAxis: input.insertionAxis,
      marginCentroid: loopCentroid(input.marginLoopFlat),
      radiusMm: r.radiusMm,
      minFacingCos: r.minFacingCos,
      cervicalOffsetMm: r.cervicalOffsetMm,
      closureDepthMm: r.closureDepthMm,
      capturedTriangleCount: r.capturedTriangleCount,
      capturedAreaMm2: r.capturedAreaMm2,
      windowBoundaryBandMm: r.windowBoundaryBandMm,
      foldTrianglesDropped: r.foldTrianglesDropped,
    },
  };
}

/** Captures the antagonist from the opposite-arch scan through the
 * `occlusal` window. No pick is needed: the seed is the margin centroid,
 * which the kernel snaps to its closest point on that scan (a ray along the
 * insertion axis can pass beside an anterior antagonist — overjet). */
export async function runAntagonistCapture(
  pool: CapturePool,
  input: Omit<NeighbourCaptureInput, 'side' | 'seed'>,
): Promise<CapturedNeighbour> {
  const { contentHash } = input.scan;
  const positionsCopy = input.scan.positions.slice();
  const indicesCopy = input.scan.indices.slice();
  await pool.run(
    'buildBvh',
    { contentHash, positions: positionsCopy, indices: indicesCopy },
    { transfer: [positionsCopy.buffer, indicesCopy.buffer], affinityKey: contentHash },
  );
  return extractOnCachedScan(pool, {
    ...input,
    side: 'antagonist',
    seed: loopCentroid(input.marginLoopFlat),
  });
}

/** Whether a journaled capture was cut against the current margin + axis
 * (else it is stale and must be re-picked). */
export function captureMatchesDesign(
  op: Operation,
  marginLoopFlat: Float64Array,
  insertionAxis: Vec3,
): boolean {
  const same = (a: unknown, b: Vec3): boolean =>
    Array.isArray(a) && a.length === 3 && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  return (
    same(op.params['insertionAxis'], insertionAxis) &&
    same(op.params['marginCentroid'], loopCentroid(marginLoopFlat))
  );
}
