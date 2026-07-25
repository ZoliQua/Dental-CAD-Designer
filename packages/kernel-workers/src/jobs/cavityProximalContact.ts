// jobs/cavityProximalContact.ts — the Class II proximal box contact-adaptation
// job (Phase 5 Task 5): @dqcad/kernel's `adaptProximalContacts` (the per-box
// bump adaptation of the occlusal patch's proximal faces toward the
// neighbours — see @dqcad/kernel's cavity/proximalContact.ts for the
// mechanism, the byte-exact pinned anchor set, and `@errorBound`), bracketed
// by the SEAM-DIHEDRAL measurement BEFORE and AFTER (the Task-4 G1
// instrument), so the worker result carries the seam-survival evidence the
// journal needs.
//
// ## Progress, cancellation & byte-identity
//
// The adaptation is a fast synchronous Float64 op, so the job reports COARSE
// progress around its phases (0 → seam-before 0.2 → adapt 0.7 → seam-after 1)
// and checks cancellation up front. The hooks affect NO computed value: the
// job's mesh + measurements are BYTE-IDENTICAL to direct kernel calls (pinned
// by cavityProximalContactJob.test.ts).
//
// ## Direct buffers, no per-worker cache
//
// Unlike jobs/cavityOcclusalPatch.ts (whose TOOTH mesh is BVH-cache-resident),
// the patch being adapted is a fresh stage artifact and the neighbour
// submeshes are small — the payload carries the buffers directly (the
// jobs/morphAnatomy.ts precedent) and nothing is cached.
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention". NOTE: no TypeScript constructor
// parameter properties anywhere in this file (the Task 1 worker-loader
// landmine) — there are no classes here; payload/result are plain interfaces.
import {
  adaptProximalContacts,
  measureSeamDihedral,
  type IndexedMesh,
  type ProximalAdaptationInput,
  type ProximalBoxContactResult,
  type SeamEdge,
  type Vec3,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';

export interface CavityProximalContactFacePayload {
  /** Reporting key ('mesial' / 'distal' — the stage's FDI-paired side). */
  label: string;
  /** Proximal column (flat xyz) — from the patch result's `proximalFaces`. */
  columnPoints: Float64Array;
  /** Outline U (flat xyz) — pinned rim, measured over. */
  freeRunPoints: Float64Array;
  /** Neighbour surface (outward-wound), Float64 flat xyz + indices. */
  neighborPositions: Float64Array;
  neighborIndices: Uint32Array;
  /** Target signed penetration (mm, profile: proximalContactPenetrationMm). */
  targetPenetrationMm: number;
}

export interface CavityProximalContactPayload {
  /** The occlusal patch being adapted (Task-4 output). */
  patchPositions: Float64Array;
  patchIndices: Uint32Array;
  /** The tooth-with-cavity solid — the seam measurement's surrounding surface. */
  toothPositions: Float64Array;
  toothIndices: Uint32Array;
  /** The patch's occlusal seam edges + cavity-triangle exclusion (Task-4
   * result currency) — for the before/after G1 measurement. */
  seamEdges: SeamEdge[];
  cavityTriangleIndices: Uint32Array;
  /** One entry per box (mesial + distal). */
  adaptations: CavityProximalContactFacePayload[];
  /** Kernel ALGORITHM overrides (defaults applied by the kernel op). */
  maxTravelMm?: number;
  seamAnchorBandMm?: number;
}

export interface CavityProximalContactResult {
  positions: Float64Array;
  indices: Uint32Array;
  /** Per-box measured evidence (genuine closest-point residuals + clamp flags). */
  boxes: ProximalBoxContactResult[];
  clampedBoxes: string[];
  errorBoundMm: number | null;
  maxTravelMm: number;
  seamAnchorBandMm: number;
  /** Seam G1 survival evidence: measured BEFORE and AFTER the adaptation. */
  seamDihedralMaxBeforeDeg: number;
  seamDihedralMeanBeforeDeg: number;
  seamDihedralMaxAfterDeg: number;
  seamDihedralMeanAfterDeg: number;
}

function rebuildLoop(flat: Float64Array): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) loop.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return loop;
}

function cloneBoxes(boxes: readonly ProximalBoxContactResult[]): ProximalBoxContactResult[] {
  return boxes.map((b) => ({
    ...b,
    approachDirection: [b.approachDirection[0], b.approachDirection[1], b.approachDirection[2]] as Vec3,
  }));
}

/**
 * `cavityProximalContact` worker job — see this file's module doc for the
 * progress/cancellation contract and the byte-identity argument vs direct
 * kernel calls (`measureSeamDihedral` → `adaptProximalContacts` →
 * `measureSeamDihedral`).
 *
 * @throws {TypeError} for malformed flat arrays / missing adaptations (before
 * heavy work).
 * @throws {JobCancelledError} if cancelled.
 * @throws propagates @dqcad/kernel's typed errors
 * (`ProximalColumnNotOnPatchError`, `ProximalNeighborMeshError`,
 * `ProximalBandTooWideError`, `SeamEdgeNotOnMeshError`, ...).
 */
export const cavityProximalContactJob = async (
  payload: CavityProximalContactPayload,
  ctx: JobContext,
): Promise<CavityProximalContactResult> => {
  if (!payload.adaptations || payload.adaptations.length === 0) {
    throw new TypeError('cavityProximalContact: adaptations must have at least one box');
  }
  for (const a of payload.adaptations) {
    if (a.columnPoints.length % 3 !== 0 || a.freeRunPoints.length % 3 !== 0) {
      throw new TypeError(`cavityProximalContact: box "${a.label}" column/freeRun flat arrays must be xyz triples`);
    }
  }
  ctx.progress(0);
  if (await ctx.cancelled()) throw new JobCancelledError();

  const patchMesh: IndexedMesh = { positions: payload.patchPositions, indices: payload.patchIndices };
  const toothMesh: IndexedMesh = { positions: payload.toothPositions, indices: payload.toothIndices };
  const exclude = new Set(payload.cavityTriangleIndices);

  const before = measureSeamDihedral(patchMesh, toothMesh, payload.seamEdges, { excludeToothTriangles: exclude });
  ctx.progress(0.2);

  const adaptations: ProximalAdaptationInput[] = payload.adaptations.map((a) => ({
    label: a.label,
    columnPoints: rebuildLoop(a.columnPoints),
    freeRunPoints: rebuildLoop(a.freeRunPoints),
    neighborMesh: { positions: a.neighborPositions, indices: a.neighborIndices },
    targetPenetrationMm: a.targetPenetrationMm,
  }));
  const options = {
    ...(payload.maxTravelMm !== undefined ? { maxTravelMm: payload.maxTravelMm } : {}),
    ...(payload.seamAnchorBandMm !== undefined ? { seamAnchorBandMm: payload.seamAnchorBandMm } : {}),
  };
  const result = adaptProximalContacts(patchMesh, adaptations, options);
  ctx.progress(0.7);

  const after = measureSeamDihedral(result.mesh, toothMesh, payload.seamEdges, { excludeToothTriangles: exclude });
  ctx.progress(1);

  return {
    positions: result.mesh.positions,
    indices: result.mesh.indices,
    boxes: cloneBoxes(result.boxes),
    clampedBoxes: [...result.clampedBoxes],
    errorBoundMm: result.errorBoundMm,
    maxTravelMm: result.maxTravelMm,
    seamAnchorBandMm: result.seamAnchorBandMm,
    seamDihedralMaxBeforeDeg: before.maxDeg,
    seamDihedralMeanBeforeDeg: before.meanDeg,
    seamDihedralMaxAfterDeg: after.maxDeg,
    seamDihedralMeanAfterDeg: after.meanDeg,
  };
};
