// jobs/bridgePontic.ts — the BRIDGE PONTIC + GINGIVAL INTERFACE worker job
// (Phase 6 Task 3): places the library pontic (P4 placement machinery, neighbours
// = the two abutment units, shared insertion axis) and shapes its base against
// the edentulous-ridge (gingiva) mesh per STYLE at the CONFIGURED relief
// (@dqcad/kernel's `shapePonticBase`), then measures the base ↔ gingiva relief
// (`measurePonticRelief` — the blend-independent instrument). Returns the placed
// pontic body + the shaped base surface + the measured relief field (the ±20 µm
// acceptance evidence Task 6's whole-bridge QC consumes).
//
// ## Determinism / byte-identity
//
// A thin driver over the kernel ops — it computes NO value the ops don't: the
// same payload yields byte-identical placed body + base meshes + measured stats
// (pinned by bridgePonticJob.test.ts vs a direct kernel call). The synthetic
// gingival seat ring (a pontic has no prep margin) is built by the SHARED kernel
// helper `synthPonticSeatRing`, so the worker's placement is byte-identical to
// the cad-pipeline stage's.
//
// ## Progress / cancellation
//
// A pontic build is FAST (a placement transform + a parametric base + a few
// thousand SDF queries), so progress is PHASE-level (place → shape → measure)
// with a cooperative cancel check before each phase. `checkCancel` throws
// `JobCancelledError`; the job also checks cancellation up front.
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
import {
  buildBvh,
  computePseudonormals,
  solveAnatomyPlacement,
  buildPlacementTransform,
  placeMesh,
  synthPonticSeatRing,
  shapePonticBase,
  measurePonticRelief,
  type CanonicalFrameAxes,
  type IndexedMesh,
  type Vec3,
  type PonticInterfaceStyle,
  type PonticInterfaceParams,
  type PonticBaseFootprint,
  type PonticBaseResolution,
  type RidgeCrestCylinder,
  type PonticReliefPatchStats,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';

export interface BridgePonticPayload {
  /** Gingiva (edentulous ridge) mesh — flat xyz + triangle indices. */
  gingivaPositions: Float64Array;
  gingivaIndices: Uint32Array;
  /** Placement inputs. */
  canonicalFrame: CanonicalFrameAxes;
  libraryPositions: Float64Array;
  libraryIndices: Uint32Array;
  insertionAxis: Vec3;
  mesialNeighborPositions: Float64Array;
  distalNeighborPositions: Float64Array;
  antagonistPositions: Float64Array | null;
  /** Interface. */
  style: PonticInterfaceStyle;
  ridgeCrest: RidgeCrestCylinder;
  params: PonticInterfaceParams;
  footprint: PonticBaseFootprint;
  resolution: PonticBaseResolution;
  /** Synthetic gingival seat-ring params (for placement). */
  seatRingRadiusMm: number;
  seatRingSegments: number;
}

export interface BridgePonticResult {
  /** Placed library pontic BODY. */
  bodyPositions: Float64Array;
  bodyIndices: Uint32Array;
  /** Shaped base interface surface. */
  basePositions: Float64Array;
  baseIndices: Uint32Array;
  /** Measured relief: the PRIMARY (acceptance) patch + non-primary patches. */
  primary: PonticReliefPatchStats;
  secondary: Readonly<Record<string, PonticReliefPatchStats>>;
  analyticCrossCheckMaxGapMm: number | null;
  /** The configured primary-patch target (mm, signed) + construction @errorBound. */
  primaryTargetMm: number;
  errorBoundMm: number;
}

function rebuildMesh(positions: Float64Array, indices: Uint32Array): IndexedMesh {
  return { positions, indices };
}

function validate(payload: BridgePonticPayload): void {
  if (payload.gingivaIndices.length < 3 || payload.gingivaPositions.length < 9) {
    throw new TypeError('bridgePontic: gingiva mesh must have >= 1 triangle / 3 vertices');
  }
  if (payload.libraryIndices.length < 3) {
    throw new TypeError('bridgePontic: library mesh must have >= 1 triangle');
  }
  if (payload.mesialNeighborPositions.length < 3 || payload.distalNeighborPositions.length < 3) {
    throw new TypeError('bridgePontic: both neighbour position arrays must be non-empty');
  }
  if (!(payload.seatRingRadiusMm > 0)) {
    throw new TypeError(`bridgePontic: seatRingRadiusMm must be > 0, got ${payload.seatRingRadiusMm}`);
  }
}

/**
 * `bridgePontic` worker job — see this file's module doc. Places the pontic,
 * shapes its base per style at the configured relief, measures the relief field.
 *
 * @throws {TypeError} for invalid meshes / seat radius (before any heavy work).
 * @throws {JobCancelledError} on cooperative cancellation.
 * @throws propagates `solveAnatomyPlacement`'s / `shapePonticBase`'s /
 * `measurePonticRelief`'s typed errors (@dqcad/kernel).
 */
export const bridgePonticJob = async (
  payload: BridgePonticPayload,
  ctx: JobContext,
): Promise<BridgePonticResult> => {
  validate(payload);
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  // Site centre station = footprint midpoint (matches the stage).
  const siteStationMm = (payload.footprint.stationMinMm + payload.footprint.stationMaxMm) / 2;
  const seatRing = synthPonticSeatRing(payload.ridgeCrest, siteStationMm, payload.seatRingRadiusMm, payload.seatRingSegments);

  // PLACEMENT.
  const libraryMesh = rebuildMesh(payload.libraryPositions, payload.libraryIndices);
  const solution = solveAnatomyPlacement({
    canonicalFrame: payload.canonicalFrame,
    libraryMesh,
    marginLoop: seatRing,
    insertionAxis: payload.insertionAxis,
    mesialNeighborPositions: payload.mesialNeighborPositions,
    distalNeighborPositions: payload.distalNeighborPositions,
    antagonistPositions: payload.antagonistPositions,
  });
  const transform = buildPlacementTransform(solution.frame, payload.canonicalFrame);
  const body = placeMesh(libraryMesh, transform);
  ctx.progress(0.3);
  if (await ctx.cancelled()) throw new JobCancelledError();

  // INTERFACE.
  const shaped = shapePonticBase(payload.ridgeCrest, payload.style, payload.params, payload.footprint, payload.resolution);
  ctx.progress(0.5);
  if (await ctx.cancelled()) throw new JobCancelledError();

  // MEASUREMENT.
  const gingiva = rebuildMesh(payload.gingivaPositions, payload.gingivaIndices);
  const bvh = buildBvh(gingiva);
  const pn = computePseudonormals(gingiva);
  const relief = measurePonticRelief(gingiva, bvh, pn, shaped.samples, payload.ridgeCrest);
  ctx.progress(1);

  return {
    bodyPositions: body.positions,
    bodyIndices: body.indices,
    basePositions: shaped.mesh.positions,
    baseIndices: shaped.mesh.indices,
    primary: relief.primary,
    secondary: relief.secondary,
    analyticCrossCheckMaxGapMm: relief.analyticCrossCheckMaxGapMm,
    primaryTargetMm: shaped.primaryTargetMm,
    errorBoundMm: shaped.errorBoundMm,
  };
};
