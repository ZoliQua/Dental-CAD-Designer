// jobs/placeAnatomy.ts — the anatomy-placement worker job (Phase 4 Task 5):
// @dqcad/kernel's `solveAnatomyPlacement` → `buildPlacementTransform` →
// `placeMesh` (the deterministic, closed-form placement transform solve — see
// @dqcad/kernel's anatomy/placement.ts for the frame construction, the two
// scale factors and the Kabsch-based alignment). FAST (a transform solve, not
// heavy geometry): no BVH/SDF, no progress slices — it takes the library +
// neighbour + antagonist geometry as flat buffers in the payload and returns
// the placed mesh + the 4×4 transform.
//
// ## Determinism / byte-identity
//
// The job is a thin wrapper over the kernel op — it computes NO value the op
// doesn't; the same payload yields a byte-identical transform + placed mesh
// (pinned by placeAnatomyJob.test.ts). Manual overrides (a landmark handle, a
// world translation, a scale multiplier) are applied through the kernel's own
// PlacementFrame helpers, in the same fixed order as the cad-pipeline stage.
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
import {
  solveAnatomyPlacement,
  buildPlacementTransform,
  placeMesh,
  translatePlacement,
  rescalePlacement,
  solveLandmarkHandleTranslation,
  type CanonicalFrameAxes,
  type PlacementFrame,
  type Vec3,
  type Mat4,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';

export interface PlaceAnatomyManualOverride {
  landmarkHandle?: { landmark: string; targetMm: Vec3 };
  translationMm?: Vec3;
  scale?: { md?: number; bl?: number; og?: number };
}

export interface PlaceAnatomyPayload {
  canonicalFrame: CanonicalFrameAxes;
  /** Library mesh, flat xyz positions + triangle indices (asset space). */
  libraryPositions: Float64Array;
  libraryIndices: Uint32Array;
  /** Dense on-surface margin loop, flat xyz (deduplicated by the caller). */
  marginLoop: Float64Array;
  insertionAxis: Vec3;
  mesialNeighborPositions: Float64Array;
  distalNeighborPositions: Float64Array;
  antagonistPositions: Float64Array | null;
  /** Named landmark points (asset space) — only needed when a manual handle
   * override references one. */
  landmarks?: Readonly<Record<string, Vec3>>;
  manualOverride?: PlaceAnatomyManualOverride;
}

export interface PlaceAnatomyResult {
  /** Column-major 16-number transform (SceneNode convention). */
  transform: readonly number[];
  /** Placed (transformed) library mesh. */
  positions: Float64Array;
  indices: Uint32Array;
  /** The solved (post-override) placement frame, echoed for the UI/journal. */
  originMm: Vec3;
  mesialDistal: Vec3;
  buccoLingual: Vec3;
  occlusoGingival: Vec3;
  scaleMesialDistal: number;
  scaleBuccoLingual: number;
  scaleOcclusoGingival: number;
  /** Measurements the auto-solve produced. */
  nativeMesialDistalWidthMm: number;
  nativeOcclusoGingivalHeightMm: number;
  targetMesialDistalWidthMm: number;
  targetOcclusoGingivalHeightMm: number | null;
  usedProximalGap: boolean;
  antagonistUsed: boolean;
  occlusoGingivalReoriented: boolean;
}

function rebuildLoop(flat: Float64Array): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) loop.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return loop;
}

export class UnknownLandmarkError extends Error {
  constructor(landmark: string) {
    super(`placeAnatomy: manual handle references unknown landmark "${landmark}" (not in payload.landmarks)`);
    this.name = 'UnknownLandmarkError';
  }
}

/**
 * `placeAnatomy` worker job — see this file's module doc. Deterministic; no
 * progress slices (fast). Cancellation is checked once up front.
 *
 * @throws {JobCancelledError} if cancelled before the solve.
 * @throws {UnknownLandmarkError} if a manual handle names an unknown landmark.
 * @throws propagates @dqcad/kernel's `DegeneratePlacementError`.
 */
export const placeAnatomyJob = async (payload: PlaceAnatomyPayload, ctx: JobContext): Promise<PlaceAnatomyResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();

  const solution = solveAnatomyPlacement({
    canonicalFrame: payload.canonicalFrame,
    libraryMesh: { positions: payload.libraryPositions, indices: payload.libraryIndices },
    marginLoop: rebuildLoop(payload.marginLoop),
    insertionAxis: payload.insertionAxis,
    mesialNeighborPositions: payload.mesialNeighborPositions,
    distalNeighborPositions: payload.distalNeighborPositions,
    antagonistPositions: payload.antagonistPositions,
  });

  let frame: PlacementFrame = solution.frame;
  const override = payload.manualOverride;
  if (override?.landmarkHandle) {
    const point = payload.landmarks?.[override.landmarkHandle.landmark];
    if (!point) throw new UnknownLandmarkError(override.landmarkHandle.landmark);
    frame = solveLandmarkHandleTranslation(frame, payload.canonicalFrame, point, override.landmarkHandle.targetMm);
  }
  if (override?.translationMm) frame = translatePlacement(frame, override.translationMm);
  if (override?.scale) frame = rescalePlacement(frame, override.scale);

  const transform: Mat4 = buildPlacementTransform(frame, payload.canonicalFrame);
  const placed = placeMesh(
    { positions: payload.libraryPositions, indices: payload.libraryIndices },
    transform,
  );

  return {
    transform,
    positions: placed.positions,
    indices: placed.indices,
    originMm: frame.originMm,
    mesialDistal: frame.mesialDistal,
    buccoLingual: frame.buccoLingual,
    occlusoGingival: frame.occlusoGingival,
    scaleMesialDistal: frame.scaleMesialDistal,
    scaleBuccoLingual: frame.scaleBuccoLingual,
    scaleOcclusoGingival: frame.scaleOcclusoGingival,
    nativeMesialDistalWidthMm: solution.measurements.nativeMesialDistalWidthMm,
    nativeOcclusoGingivalHeightMm: solution.measurements.nativeOcclusoGingivalHeightMm,
    targetMesialDistalWidthMm: solution.measurements.targetMesialDistalWidthMm,
    targetOcclusoGingivalHeightMm: solution.measurements.targetOcclusoGingivalHeightMm,
    usedProximalGap: solution.measurements.usedProximalGap,
    antagonistUsed: solution.measurements.antagonistUsed,
    occlusoGingivalReoriented: solution.measurements.occlusoGingivalReoriented,
  };
};
